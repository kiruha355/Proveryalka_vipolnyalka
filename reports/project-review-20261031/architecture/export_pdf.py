"""Export the seven architecture SVGs as searchable vector A4 landscape pages."""
from pathlib import Path
from io import BytesIO
import re,subprocess,xml.etree.ElementTree as ET
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4,landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pypdf import PdfReader,PdfWriter
root=Path(__file__).resolve().parents[3]
source=Path(__file__).resolve().parent/'diagrams'
tmp=root/'tmp/pdfs/architecture';tmp.mkdir(parents=True,exist_ok=True)
out=root/'output/pdf/proveryalka-architecture.pdf';out.parent.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('DiagramSans','/Library/Fonts/Arial Unicode.ttf'))
writer=PdfWriter();w,h=landscape(A4)
for number,p in enumerate(sorted(source.glob('*.svg')),1):
 s=p.read_text();s=re.sub(r'var\(--[\w-]+,\s*([^()]+)\)',lambda m:m.group(1).strip(),s)
 s=s.replace('var(--font-sans,system-ui,sans-serif)','Arial, sans-serif')
 static=tmp/(p.stem+'.svg');static.write_text(s)
 pagepdf=tmp/(p.stem+'.pdf')
 subprocess.run(['rsvg-convert','--format=pdf','--page-width=297mm','--page-height=210mm','--width=277mm','--height=173mm','--keep-aspect-ratio','--left=10mm','--top=23mm','--background-color=white','--output',str(pagepdf),str(static)],check=True)
 page=PdfReader(pagepdf).pages[0]
 title=ET.fromstring(s).find('{http://www.w3.org/2000/svg}title').text
 overlay=BytesIO();c=canvas.Canvas(overlay,pagesize=(w,h));c.setFont('DiagramSans',16);c.setFillColorRGB(.14,.15,.17);c.drawString(28,h-29,f'{number}. {title}')
 c.setFont('DiagramSans',8);c.setFillColorRGB(.43,.44,.47)
 c.drawString(28,h-44,'Проверялка | 31.10.2026 | общая локальная интеграция PR63-71')
 c.drawString(28,15,'Mput13: UI  |  SOKLY6: API и поставка  |  kiruha355: аналитик  |  kontar0: TLC')
 c.drawRightString(w-28,15,f'{number} / 7');c.save();overlay.seek(0)
 page.merge_page(PdfReader(overlay).pages[0]);writer.add_page(page);writer.add_outline_item(title,number-1)
writer.add_metadata({'/Title':'Архитектура Проверялки','/Author':'Proveryalka project','/Subject':'Компоненты, анализ, TLC, данные, генератор, источники и поставка'})
with out.open('wb') as f:writer.write(f)
reader=PdfReader(out);assert len(reader.pages)==7
for p in reader.pages:assert len(p.extract_text())>150
print(out);print('7 searchable vector pages; bytes',out.stat().st_size)
