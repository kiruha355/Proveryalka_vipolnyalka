import ast
import re
from pathlib import PurePosixPath

from ...services import ServiceError
from .index import file_lines


CODE = {".py", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php", ".swift", ".c", ".cpp", ".sql", ".tla"}
DOCS = {".md", ".rst", ".txt"}
ENTRY_WORDS = {"api", "route", "controller", "handler", "service", "domain", "model", "main"}
ANCILLARY = {"test", "migration", "alembic", "generated", "fixture"}
SCOPES = {"backend", "frontend"}


def words(text):
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    words = (word.casefold() for word in re.findall(r"[^\W_]+", text) if len(word) > 2)
    return {word[:-1] if word.isascii() and len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word
            for word in words}


def imported_modules(path, source):
    if not path.endswith(".py"):
        return set()
    try:
        tree = ast.parse(source)
    except (SyntaxError, RecursionError, ValueError):
        return set()
    links = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            links.update(name.name for name in node.names)
        elif isinstance(node, ast.ImportFrom):
            package = PurePosixPath(path).parts[:-node.level] if node.level else ()
            module = ".".join((*package, *(node.module or "").split("."))).strip(".")
            if module:
                links.add(module)
            links.update(f"{module}.{name.name}".strip(".") for name in node.names)
    return links


def select_files(snapshot, contents, query, limits, header_size, reserved_bytes, excluded=()):
    query_words = words(query)
    scope = query_words & SCOPES
    terms = query_words - scope
    candidates = []
    for item in snapshot["files"]:
        path = item["path"]
        suffix = PurePosixPath(path).suffix.lower()
        if path in excluded or suffix not in CODE | DOCS or not item["lines"]:
            continue
        path_words = words(path)
        lines = file_lines(contents[path])
        matches = [len(words(line) & terms) for line in lines] if terms else [0]
        best = max(matches)
        score = 18 * len(path_words & terms) + 6 * best + min(sum(matches), 8)
        score += 6 * len(path_words & ENTRY_WORDS) + (8 if suffix in CODE else 0)
        score += 16 * len(path_words & scope)
        if scope and (path_words & (SCOPES - scope)):
            score -= 32
        score -= 32 if path_words & ANCILLARY else 0
        candidates.append((score, item, lines, matches.index(best)))
    candidates.sort(key=lambda row: (-row[0], row[1]["path"]))
    linked = set().union(*(imported_modules(item["path"], contents[item["path"]]) for _, item, _, _ in candidates[:3]))
    linked_paths = {name.replace(".", "/") + ".py" for name in linked}
    candidates.sort(key=lambda row: (
        -(row[0] + 20 * any(("/" + row[1]["path"]).endswith("/" + path) for path in linked_paths)),
        row[1]["path"],
    ))
    docs = next((row for row in candidates if PurePosixPath(row[1]["path"]).suffix.lower() in DOCS), None)
    if docs is not None and docs not in candidates[:5]:
        candidates.remove(docs)
        candidates.insert(4, docs)

    remaining_lines = limits.context_lines
    remaining_bytes = limits.context_bytes - reserved_bytes
    selected = []
    for _, item, lines, focus in candidates:
        if len(selected) == 20 or remaining_lines <= 0:
            break
        maximum = min(120, max(1, limits.context_lines // 3), remaining_lines)
        start = min(max(0, focus - maximum // 3), max(0, len(lines) - maximum))
        overhead = header_size(item)
        available = remaining_bytes - overhead
        end, size = start, 0
        for line in lines[start:start + maximum]:
            line_bytes = len(line.encode())
            if size + line_bytes > available:
                break
            size += line_bytes
            end += 1
        if end == start:
            continue
        selected.append({"path": item["path"], "sha256": item["sha256"], "start_line": start + 1, "end_line": end})
        remaining_lines -= end - start
        remaining_bytes -= overhead + size
    if not selected:
        raise ServiceError(422, "REPOSITORY_NO_CONTEXT", "No complete source line fits the context budget")
    read_lines = limits.context_lines - remaining_lines
    return {
        "selection": {"manifest_sha256": snapshot["manifest_sha256"], "files": selected},
        "selected_line_count": read_lines,
        "indexed_file_count": len(snapshot["files"]),
        "coverage": "complete" if sum(item["lines"] for item in snapshot["files"]) == read_lines else "partial",
    }
