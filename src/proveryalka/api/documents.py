"""Текст источника из загруженного TXT, MD или DOCX. Файл не сохраняется на диск и не открывается по пути."""
import hashlib
import io
import zipfile
from xml.etree import ElementTree

from ..services import ServiceError


FORMATS = {
    ".txt": ("txt", "text/plain"),
    ".md": ("md", "text/markdown"),
    ".markdown": ("md", "text/markdown"),
    ".docx": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
}
WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MAX_ZIP_ENTRIES = 2000
MAX_DOCUMENT_XML = 20 * 1024 * 1024


def clean_filename(filename):
    # Имя — только подпись источника; путь клиента отбрасывается.
    name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    return name[:200] or "document"


def invalid(message, code="DOCUMENT_INVALID", status=422):
    return ServiceError(status, code, message)


def decode_text(data):
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise invalid("Text documents must be UTF-8", "DOCUMENT_ENCODING") from error
    if "\x00" in text:
        raise invalid("Text document contains NUL bytes", "DOCUMENT_ENCODING")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def read_limited(archive, entry):
    # Заявленный размер в zip может быть ложным: читаем не больше предела.
    with archive.open(entry) as stream:
        data = stream.read(MAX_DOCUMENT_XML + 1)
    if len(data) > MAX_DOCUMENT_XML:
        raise invalid("DOCX text part is too large", "DOCUMENT_TOO_LARGE", 413)
    return data


def walk(element, lines, current):
    for child in element:
        if child.tag == WORD + "p":
            paragraph = []
            walk(child, lines, paragraph)
            lines.append("".join(paragraph))
        elif child.tag == WORD + "t":
            current.append(child.text or "")
        elif child.tag == WORD + "tab":
            current.append("\t")
        elif child.tag in (WORD + "br", WORD + "cr"):
            current.append("\n")
        else:
            # w:delText (удалённый в рецензировании текст) не является частью документа.
            walk(child, lines, current)


def docx_text(data):
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise invalid("DOCX is not a valid zip archive") from error
    with archive:
        entries = archive.infolist()
        if len(entries) > MAX_ZIP_ENTRIES:
            raise invalid("DOCX contains too many parts", "DOCUMENT_TOO_LARGE", 413)
        try:
            entry = archive.getinfo("word/document.xml")
        except KeyError as error:
            raise invalid("DOCX has no word/document.xml") from error
        if entry.flag_bits & 0x1:
            raise invalid("Encrypted DOCX is not supported")
        if entry.file_size > MAX_DOCUMENT_XML:
            raise invalid("DOCX text part is too large", "DOCUMENT_TOO_LARGE", 413)
        try:
            xml = read_limited(archive, entry)
        except (zipfile.BadZipFile, NotImplementedError, OSError, EOFError) as error:
            raise invalid("DOCX text part cannot be read") from error
    # В DOCX нет DTD; любые объявления сущностей отклоняются до разбора.
    if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
        raise invalid("DOCX with DTD or entities is not supported")
    try:
        root = ElementTree.fromstring(xml)
        body = root.find(WORD + "body")
        if body is None:
            raise invalid("DOCX has no document body")
        lines = []
        walk(body, lines, [])
    except (ElementTree.ParseError, RecursionError) as error:
        raise invalid("DOCX XML cannot be parsed") from error
    return "\n".join(lines)


def extract_document(filename, data, max_bytes, max_chars):
    name = clean_filename(filename)
    suffix = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if suffix not in FORMATS:
        raise invalid("Supported documents: .txt, .md, .docx", "UNSUPPORTED_DOCUMENT", 415)
    if not data:
        raise invalid("Document is empty", "DOCUMENT_EMPTY")
    if len(data) > max_bytes:
        raise invalid(f"Document exceeds {max_bytes} bytes", "DOCUMENT_TOO_LARGE", 413)
    kind, media_type = FORMATS[suffix]
    text = docx_text(data) if kind == "docx" else decode_text(data)
    text = text.strip()
    if not text:
        raise invalid("Document contains no text", "DOCUMENT_EMPTY")
    if len(text) > max_chars:
        raise invalid("Document text exceeds configured input limit", "INPUT_LIMIT")
    return text, {
        "filename": name, "format": kind, "media_type": media_type, "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(), "characters": len(text),
    }
