from pathlib import Path
from html import escape
import zipfile

ROOT = Path(__file__).parent
OUT = ROOT / 'diagrams'
OUT.mkdir(parents=True, exist_ok=True)

STYLE = '''
text{font-family:var(--font-sans,system-ui,sans-serif);font-size:14px;fill:var(--foreground,#282b30)}
.small{font-size:12px;fill:var(--muted-foreground,#666a72)}.tiny{font-size:11px;fill:var(--muted-foreground,#666a72)}
.title{font-size:15px;font-weight:650}.owner{font-size:12px;fill:var(--muted-foreground,#666a72)}
.box{fill:var(--card,#fafafa);stroke:var(--border,#d2d5db);stroke-width:1.5}
.ui .box{stroke:var(--chart-1,#5077be)}.api .box{stroke:var(--chart-2,#4c9480)}
.agent .box{stroke:var(--chart-3,#b27b35)}.checker .box{stroke:var(--chart-4,#8d69a7)}
.band{fill:var(--secondary,#f1f2f4);stroke:var(--border,#d2d5db);stroke-width:1}
.frame{fill:none;stroke:var(--border,#d2d5db);stroke-width:1.3}
.pending{stroke-dasharray:6 5}.line{fill:none;stroke:var(--muted-foreground,#666a72);stroke-width:1.6}
.accent{stroke:var(--primary,#5077be);stroke-width:2}.bad{stroke:var(--destructive,#b9483e);stroke-width:1.8}
.badtext{fill:var(--destructive,#b9483e)}.goodtext{fill:var(--success,#428662)}
'''

class Figure:
    def __init__(self, slug, title, w, h, description):
        self.slug, self.title, self.w, self.h = slug, title, w, h
        self.items = [f'<title>{escape(title)}</title><desc>{escape(description)}</desc>', f'<style>{STYLE}</style>', '''<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="var(--muted-foreground,#666a72)"/></marker></defs>''']
    def text(self, x, y, value, cls='', anchor='start'):
        self.items.append(f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{escape(value)}</text>')
    def box(self, x, y, w, h, title, lines=(), owner='', cls=''):
        if isinstance(lines, str): lines=(lines,)
        self.items.append(f'<g class="{cls}"><rect class="box" x="{x}" y="{y}" width="{w}" height="{h}" rx="5"/>')
        self.text(x+14, y+25, title, 'title')
        for i, line in enumerate(lines):
            if line: self.text(x+14, y+48+i*19, line, 'small')
        if owner: self.text(x+14, y+h-12, owner, 'owner')
        self.items.append('</g>')
    def frame(self, x,y,w,h,label, pending=False):
        self.items.append(f'<rect class="frame {"pending" if pending else ""}" x="{x}" y="{y}" width="{w}" height="{h}" rx="6"/>')
        self.text(x+12,y+20,label,'small')
    def path(self, d, cls='', arrow=True):
        self.items.append(f'<path class="line {cls}" d="{d}"'+(' marker-end="url(#arr)"' if arrow else '')+'/>')
    def label(self,x,y,value,anchor='middle'):
        self.text(x,y,value,'small',anchor)
    def svg(self):
        body=''.join(self.items).replace('id="arr"',f'id="arr-{self.slug}"').replace('url(#arr)',f'url(#arr-{self.slug})')
        return f'<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}">'+body+'</svg>'

figures=[]

f=Figure('01-components','Компоненты приложения',980,650,'Клиент Mput13 обращается к API SOKLY6. API запускает аналитик kiruha355, ядро TLC kontar0 и генератор. История и версии сохраняются в SQLite, материалы проверки на диске. LLM, Java и Docker — отдельные исполнители.')
f.frame(330,20,370,535,'Python / FastAPI · один backend')
f.box(20,75,255,115,'Клиент React / TypeScript',('Чат, требования, версии','Граф, трасса, файлы и тесты'),'Mput13 · #32–#40, #49','ui')
f.box(350,65,330,75,'HTTP API + очередь runs',('REST-запросы, отмена, SSE'),'SOKLY6 · #20–#27','api')
f.box(350,190,330,75,'Аналитик требований',('Уточнения → строгая модель'),'kiruha355 · #12–#19, #29','agent')
f.box(350,315,330,75,'TLCChecker',('DSL → TLA+ → отчёт и трасса'),'kontar0 · #2–#11, #43','checker')
f.box(350,440,330,75,'CodegenService',('Модель → проект; отдельный test run'),'#41 + #48 · интеграция этого раунда','api')
f.box(750,190,210,75,'LLM runtime',('GPT по подписке','локальный codex app-server'),cls='agent')
f.box(750,315,210,75,'Java: SANY / TLC',('Синтаксис и проверка модели',),cls='checker')
f.box(750,440,210,75,'DockerSandbox',('Изолированный pytest',),cls='api')
f.box(20,430,255,100,'SQLite',('История, источники, версии','runs, отчёты, файлы генерации'),'SOKLY6 · storage','api')
f.box(350,575,330,65,'Каталог материалов TLC',('Spec.tla, .cfg, trace, logs, manifest',),cls='checker')
f.path('M275 112H350');f.label(310,100,'REST')
f.path('M350 125H296V160H275');f.label(307,182,'SSE')
f.path('M380 140V165H336V477',arrow=False)
for y in (227,352,477):f.path(f'M336 {y}H350')
f.path('M430 140V155H310V478H275');f.label(286,330,'сохранение',anchor='end')
for y in (227,352,477):f.path(f'M680 {y}H750')
f.path('M680 352H720V607H680');f.label(710,570,'артефакты',anchor='end')
f.label(490,55,'Общий язык обмена: BehavioralModel 1.0 + VerificationReport')
figures.append(f)

f=Figure('02-analysis-check','Путь описания и результата проверки',980,525,'Агент строит модель из исходных текстов и ответов, валидатор проверяет её структуру. Человек запускает проверку вручную. TLC возвращает отчёт, аналитик объясняет сохранённый отчёт. Явное исправление создаёт новую версию и новый запуск.')
f.box(20,40,210,100,'Исходные материалы',('Текст / TXT / MD / DOCX','Source + точные цитаты'),'SOKLY6 + клиент Mput13','api')
f.box(285,40,270,100,'LLM + валидация',('Требования, вопросы, guard/effects','Ссылки, типы, явные исправления'),'kiruha355 · agent/*','agent')
f.box(615,40,340,100,'Неизменяемая версия модели',('BehavioralModel: variables, transitions,','properties, requirements, source_refs'),'model_id + version_id + spec_hash','api')
f.path('M230 90H285');f.path('M555 90H615')
f.path('M350 140V180H125V140');f.label(230,173,'вопрос → ответ пользователя')
f.box(615,230,340,85,'«Проверить версию»',('Ручной запуск всех правил версии',),'Mput13 → API → kontar0','ui')
f.path('M785 140V230');f.label(800,184,'после просмотра',anchor='start');f.label(800,202,'модели',anchor='start')
f.box(285,230,270,85,'Сохранённый отчёт TLC',('Статус каждого правила + трасса',),'Сперва сохранение, затем объяснение','checker')
f.path('M615 273H555')
f.box(20,230,210,85,'Объяснение в чате',('Почему получился такой путь',),'LLM читает фактический отчёт','agent')
f.path('M285 273H230')
f.box(285,385,390,100,'Явное изменение пользователя',('Новая версия → новая ручная проверка','Старая версия и её отчёт остаются'),'Решение по смыслу принимает человек','ui')
f.path('M420 315V385');f.label(430,353,'при нарушении',anchor='start')
f.path('M675 428H970V25H785V40','accent');f.label(790,505,'без перезаписи старых результатов')
figures.append(f)

f=Figure('03-checker','Внутреннее устройство ядра проверки',980,385,'DSL проходит семантическую валидацию, компиляцию в TLA+, SANY и TLC. Парсер восстанавливает трассу, которая ещё раз проверяется по исходному DSL. Возвращается VerificationReport. Кэш использует hash модели, параметры и версию движка.')
f.box(20,50,200,85,'BehavioralModel',('Конечные области, initial,','guard/effects, свойства'),cls='checker')
f.box(270,50,200,85,'Валидация',('Типы, ссылки, области,','готовность модели'),cls='checker')
f.box(520,50,200,85,'Компиляция',('Spec.tla + .cfg на свойство',),cls='checker')
f.box(770,50,190,85,'SANY → TLC',('Java subprocess','Срок и лимит состояний'),cls='checker')
for x in (220,470,720):f.path(f'M{x} 92H{x+50}')
f.box(770,230,190,95,'Парсер + валидация',('Статусы и шаги трассы','Проверка шага по DSL'),cls='checker')
f.path('M865 135V230')
f.box(520,230,200,95,'VerificationReport',('property_id, status,','trace, changes, statistics'),cls='checker')
f.path('M770 277H720')
f.box(270,230,200,95,'Материалы + кэш',('Версия движка, spec_hash,','свойства и параметры'),cls='checker')
f.path('M520 277H470')
f.box(20,230,200,95,'API → интерфейс',('Отчёт отдельно от','пояснения агента'),cls='api')
f.path('M270 277H220')
f.label(490,185,'invariant · forbidden_state · reachable · deadlock_free')
f.label(490,365,'TIMEOUT / STATE_LIMIT_REACHED / ENGINE_ERROR не означают, что правило выполнено.')
figures.append(f)

f=Figure('04-storage','Связи версий, запусков и файлов',1000,745,'Основные отношения SQLite: сессия содержит сообщения, источники и модели. Модель имеет версии. Запуск проверки привязан к версии и имеет события. Генерация привязана к версии, содержит файлы и запуски тестов.')
f.box(20,30,210,90,'sessions',('id, title, mode','Один рабочий диалог'),cls='api')
f.box(300,30,210,90,'models',('id, session_id','Объект анализа'),cls='api')
f.box(610,30,350,100,'model_versions',('id, number, parent_id, spec','spec_hash, approved'),'Изменение = новая строка','api')
f.path('M230 75H300');f.label(265,63,'1 → N')
f.path('M510 75H610');f.label(560,63,'1 → N')
f.box(20,235,210,90,'agent_messages',('sequence, message_data','Реплики и состояния диалога'),cls='api')
f.path('M125 120V235');f.label(135,185,'1 → N',anchor='start')
f.box(290,235,220,90,'sources',('kind=text, text','Исходник и ответы'),cls='api')
f.path('M180 120V165H400V235');f.label(310,155,'1 → N')
f.box(290,430,220,90,'requirements',('number, text, source_id','R1…Rn и источник'),cls='api')
f.path('M400 325V430');f.label(410,385,'1 → N',anchor='start')
f.box(610,235,350,90,'runs',('kind: agent / check / explain','version_id, result_json, parent_run_id'),cls='api')
f.path('M740 130V235');f.label(752,192,'версия → проверки',anchor='start')
f.box(20,430,210,90,'run_events',('run_id, event_id, data','Сохранённые события SSE'),cls='api')
f.path('M740 325V370H125V430');f.label(630,359,'1 run → N событий')
f.box(610,430,350,90,'codegen_generations',('generation_id, version_id','spec_hash, code_hash, record_json'),cls='api')
f.path('M960 108H986V475H960');f.label(976,412,'1 → N',anchor='end')
f.box(450,605,240,75,'codegen_files',('path, sha256, content bytes',),cls='api')
f.box(720,605,260,75,'codegen_test_runs',('status, log, result_json',),cls='api')
f.path('M785 520V560H570V605');f.label(640,551,'1 → N файлов')
f.path('M785 560H850V605');f.label(872,585,'1 → N тестов',anchor='start')
f.label(500,725,'Состав модели и source_refs хранятся в spec JSON; не все служебные FK показаны.')
figures.append(f)

f=Figure('05-codegen-sandbox','Генерация проекта и запуск тестов',980,485,'Подтверждённая неизменяемая версия поступает в детерминированный генератор. Файлы и manifest сохраняются. Пользователь отдельно запускает тесты в Docker. Код и тесты связаны с хэшами версии и генерации; результат pytest отделён от результата TLC.')
f.box(20,35,225,100,'Подтверждённая версия',('version_id + spec_hash','Снимок результатов TLC'),'Подтверждение ≠ успех TLC','ui')
f.box(300,35,285,100,'Детерминированный генератор',('DSL → шаблоны Python','FastAPI + pytest, без LLM'),'#41 · реализовано в PR64','api')
f.box(640,35,320,100,'Сохранённая генерация',('generation_id + code_hash','Файлы, manifest, SHA-256, ZIP'),'SQLite: bytes и происхождение','api')
f.path('M245 85H300');f.path('M585 85H640')
f.box(640,210,320,80,'Просмотр файлов и ZIP',('Дерево, строки, связанные правила',),'Mput13 · #49','ui')
f.path('M800 135V210')
f.frame(300,200,285,225,'Docker · граница выполнения')
f.box(320,240,245,95,'pytest сгенерированного кода',('Сеть выключена; проект read-only','Лимиты CPU / RAM / pids / времени'),cls='api')
f.path('M640 250H585');f.label(625,235,'запустить тесты',anchor='end')
f.box(20,240,225,95,'Отчёт тестового запуска',('passed / failed / timeout / …','Лог + связь с generation_id'),cls='api')
f.path('M320 285H245')
f.label(442,367,'Каждый executor владеет своими контейнерами')
f.label(442,388,'Cancel / cleanup не трогают чужой run')
f.label(490,463,'pytest может подтвердить соответствие ошибочной модели — статус TLC при этом остаётся violated.')
figures.append(f)

f=Figure('06-connections','Источники, MCP и поставка приложения',1000,705,'Текстовые документы входят в основное приложение. Репозитории, изображения и MCP подключены к основному create_app. Репозиторий превращается в ограниченный текстовый Source. Vision даёт typed extraction, но ещё не BehavioralModel. Delivery использует то же FastAPI приложение.')
f.box(20,40,215,85,'Текст / TXT / MD / DOCX',('Извлечение и точные цитаты',),cls='api')
f.box(295,40,245,85,'Source(kind=text)',('Исходник с происхождением',),cls='api')
f.box(750,40,225,220,'Основной аналитик',('Существующий send_message','run_analyst → BehavioralModel','','Новый Source начинает диалог','в новой сессии'),cls='agent')
f.path('M235 82H295');f.path('M540 82H750')
f.frame(8,157,575,122,'#46 · router включён в основной create_app')
f.box(20,190,215,70,'HTTPS-репозиторий',('Commit SHA, snapshot',),cls='api')
f.box(295,190,270,70,'Индекс → выбранные строки',('manifest/file hashes + Source',),cls='api')
f.path('M235 225H295');f.path('M565 225H750');f.label(660,210,'Source')
f.frame(8,310,970,130,'#45 · router и recovery подключены')
f.box(20,345,215,75,'Изображение / crop',('Очищенные PNG pixels',),cls='api')
f.box(295,345,245,75,'Vision через Codex',('Native image input',),cls='agent')
f.box(600,345,360,75,'Typed image analysis',('requirements + image refs + uncertainties',),cls='api')
f.path('M235 382H295');f.path('M540 382H600')
f.label(780,465,'Автоматический переход image → BehavioralModel пока отсутствует.')
f.frame(8,495,970,105,'#47 · точный маршрут /mcp; общий lifecycle')
f.box(20,525,215,60,'Кодинг-агент',('Совместимый MCP-клиент',),cls='ui')
f.box(295,525,245,60,'MCP /mcp',('Модель, проверки, тесты и код',),cls='api')
f.box(630,525,330,60,'Те же backend / codegen services',('Без второго движка или SQLite worker',),cls='api')
f.path('M235 553H295');f.path('M540 553H630')
f.box(20,640,940,60,'#31 / #44 / #48 · delivery + CI',('Native launcher → тот же create_app + Vite static; CI: frontend / backend-TLC / sandbox; provider lane отдельно',),'','api')
figures.append(f)

f=Figure('07-delivery-ci','Запуск приложения и проверочные контуры',980,625,'Native launcher проверяет зависимости и запускает то же FastAPI приложение со статикой Vite. SQLite и материалы проверок остаются в постоянных каталогах. CI отдельно проверяет клиент, настоящий TLC и Docker; реальные LLM запросы вынесены в ручной provider lane.')
f.box(20,35,235,90,'scripts/run-stack.sh',('Native запуск на loopback','Без переноса auth в контейнер'),cls='api')
f.box(315,35,260,90,'Preflight + readiness',('Vite assets, SQLite, TLC','Запись каталога материалов'),cls='api')
f.box(635,35,325,90,'Один Uvicorn / create_app',('REST + SSE + Vite static','Существующий lifespan сервисов'),cls='api')
f.path('M255 80H315');f.path('M575 80H635')
f.box(20,205,260,85,'Постоянные данные',('SQLite, TLC bundles, cache','Переживают перезапуск приложения'),cls='api')
f.box(340,205,620,85,'Исполнители на том же компьютере',('Codex app-server  ·  Java / TLC  ·  Docker sandbox','Каждый сервис штатно завершает принадлежащие ему операции'),cls='api')
f.path('M730 125V160H150V205');f.path('M800 125V205')
f.frame(8,335,970,225,'Конфигурация GitHub CI в PR70')
f.box(20,375,280,85,'frontend',('Typecheck / Vitest / build','Основной клиент + extensions'),cls='ui')
f.box(350,375,280,85,'backend-tlc',('API + настоящий SANY / TLC','Детерминированная граница LLM'),cls='checker')
f.box(680,375,280,85,'sandbox',('Настоящий Docker / pytest','Ownership и сохранение результатов'),cls='api')
f.box(315,510,350,40,'JUnit / logs / receipts / TLC bundles',(),cls='api')
f.path('M160 460V485H490V510');f.path('M490 460V510');f.path('M820 460V485H490',arrow=False)
f.label(490,603,'Ручной provider lane: отдельный запуск, явный секрет/model и лимит запросов.')
figures.append(f)

for fig in figures: (OUT/(fig.slug+'.svg')).write_text(fig.svg())

SECTIONS = [
('components', 'Общая архитектура', figures[0], 'HTTP API управляет отдельными запусками аналитика, TLC и тестов. Агент и ядро проверки связаны строгими контрактами, а не свободным текстом ответа LLM.'),
('analysis','Описание → модель → проверка', figures[1], 'Вопросы и явная правка возвращают пользователя в диалог. Проверка запускается вручную; объяснение получает уже сохранённый отчёт той же версии.'),
('checker','Ядро kontar0', figures[2], 'BehavioralModel задаёт конечную модель поведения. SANY проверяет сгенерированную спецификацию, TLC исследует её состояния. Кэш не заменяет отчёт другим результатом: ключ учитывает модель, свойства, параметры и движок.'),
('storage','Данные и неизменяемость', figures[3], 'Версия, проверка, генерация и тестовый запуск — разные сущности. По этим связям экран показывает результат выбранной версии, а старые отчёты сохраняются после исправления.'),
('codegen','Генератор и песочница', figures[4], 'Генерация синхронно создаёт файлы; исполнение тестов — отдельная асинхронная операция. Контейнер получает сохранённый проект и возвращает отчёт, а не право менять модель.'),
('connections','Новые подключения и запуск', figures[5], 'Источники #45/#46 и MCP #47 подключены к общему backend. Изображения и репозитории доступны через API; новые клиентские экраны для них пока не добавлены.'),
('delivery','Запуск и CI', figures[6], 'Delivery переиспользует существующий create_app и его жизненный цикл. CI разделяет клиент, проверку моделей и исполнение кода; ручной LLM-прогон не подменяет эти обязательные проверки.'),
]
CSS='''
:root{font-family:var(--font-sans,system-ui,sans-serif);color:var(--foreground,#292d33);--ln:var(--border,#d4d7dc);--soft:var(--muted-foreground,#686b73)}*{box-sizing:border-box}html,body{margin:0;background:transparent}body{font-size:16px;line-height:1.55}a{color:var(--primary,#4d6fb0);text-underline-offset:3px}.doc{container:atlas/inline-size}.layout{max-width:1180px;margin:auto;display:grid;grid-template-columns:170px minmax(0,1fr);gap:28px}.toc{position:sticky;top:12px;align-self:start;font-size:13px;max-height:600px;overflow:auto}.toc strong{display:block;margin-bottom:9px}.toc a{display:block;padding:5px 0;color:var(--soft);text-decoration:none}.toc a:hover,.toc a.active{color:var(--primary)}.toc summary{display:none}main{min-width:0}h1{font-size:31px;line-height:1.15;letter-spacing:-.025em;margin:0 0 12px}h2{font-size:23px;line-height:1.25;margin:0 0 11px}p{margin:9px 0 15px}.meta{font-size:12px;color:var(--soft)}.lead{font-size:18px}section{border-top:1px solid var(--ln);padding:26px 0 20px;scroll-margin-top:60px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;padding:9px 8px;border-bottom:1px solid var(--ln)}th{font-size:12px;color:var(--soft)}td:first-child,th:first-child{padding-left:0;white-space:nowrap}code{font:.88em var(--font-mono,monospace);overflow-wrap:anywhere}.legend{display:flex;flex-wrap:wrap;gap:10px 22px;margin:15px 0;font-size:12px;color:var(--soft)}.legend span{display:flex;gap:7px;align-items:center}.legend i{display:inline-block;width:22px;border-top:2px solid}.legend .dashed{border-top-style:dashed}.toolbar{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin:5px 0 7px}.toolbar button{font:12px var(--font-sans,system-ui);border:1px solid var(--ln);background:var(--card,#fafafa);color:var(--foreground);padding:4px 9px;border-radius:4px;cursor:pointer}.toolbar a{font-size:12px;margin-right:auto}.diagram{overflow:auto;border:1px solid var(--ln);border-radius:5px;padding:12px}.diagram svg{display:block;width:100%;height:auto;min-width:780px;max-width:none}figure{margin:14px 0 12px}figcaption{font-size:13px;color:var(--soft);margin-top:9px}.note{font-size:14px;color:var(--soft);border-left:3px solid var(--ln);padding-left:13px}.sources{font-size:13px;color:var(--soft);padding-left:18px}.sources li{margin:8px 0}.status{background:var(--secondary,#f2f3f5);border-radius:5px;padding:12px 15px;font-size:14px;margin:15px 0}.toc details{padding-top:2px}.foot{font-size:12px;color:var(--soft);margin:24px 0}
@container atlas (max-width:900px){.layout{grid-template-columns:minmax(0,1fr);gap:14px}.toc{position:sticky;top:0;z-index:3;background:var(--background,#fff);border-bottom:1px solid var(--ln);padding:8px 0;max-height:300px}.toc strong{display:none}.toc summary{display:list-item;cursor:pointer}.toc details:not([open]) .links{display:none}.links{display:grid;grid-template-columns:1fr 1fr;gap:2px 14px}.toc a{font-size:12px}h1{font-size:27px}}@container atlas (max-width:520px){.table table{min-width:650px}.diagram{padding:8px}.diagram svg{min-width:780px}body{font-size:15px}.lead{font-size:16px}h1{font-size:24px}h2{font-size:21px}.toolbar{flex-wrap:wrap}}
'''
nav=''.join(f'<a href="#{slug}">{escape(title)}</a>' for slug,title,_,_ in SECTIONS)
parts=[f'''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Архитектура Проверялки</title><style>{CSS}</style></head><body><div class="doc"><div class="layout"><nav class="toc" aria-label="Содержание"><strong>Архитектура</strong><details open><summary>Схемы</summary><div class="links"><a href="#team">Участники</a>{nav}<a href="#sources">Источники</a></div></details></nav><main><header><p class="meta">31.10.2026 · общая локальная интеграция PR63–70</p><h1>Архитектура Проверялки</h1><p class="lead">Четыре зоны ответственности соединяются через версионированную модель поведения: клиент Mput13, сервер SOKLY6, аналитик kiruha355 и ядро проверки kontar0.</p></header>''']
parts.append('''<section id="team"><h2>Участники и результат работы</h2><div class="table"><table><thead><tr><th>Участник</th><th>Исходная зона</th><th>Что соединяется с остальными</th></tr></thead><tbody>
<tr><td>Mput13</td><td>#32–#40, #49 · клиент</td><td>Текст и ответы пользователя, просмотр модели, ручная проверка, трасса, граф, файлы и тесты.</td></tr>
<tr><td>SOKLY6</td><td>#20–#27, #31, #44–#48 · сервер</td><td>REST/SSE, SQLite, очередь и отмена запусков, выдача файлов, окружение. Новый блок: изображения, репозитории, MCP и delivery.</td></tr>
<tr><td>kiruha355</td><td>#12–#19, #29–#30, #41 · аналитик</td><td>Извлечение требований, уточнения, формализация DSL, объяснение отчёта. Генератор #41 реализован в этом раунде отдельно.</td></tr>
<tr><td>kontar0</td><td>#1–#11, #28, #43 · проверяющее ядро</td><td>Контракты, валидатор, TLA+, SANY/TLC, статусы, контрпример, материалы и кэш.</td></tr>
</tbody></table></div><p class="note">Это зоны назначения issues в GitHub. Новые связующие доработки этого обсуждения выполнялись субагентами; подпись зоны не означает авторство каждым участником всех новых коммитов.</p></section>''')
for slug,title,fig,desc in SECTIONS:
    parts.append(f'<section id="{slug}"><h2>{escape(title)}</h2><p>{escape(desc)}</p>')
    if slug=='components':parts.append('''<div class="legend"><span><i style="border-color:var(--chart-1,#5077be)"></i>Mput13 · UI</span><span><i style="border-color:var(--chart-2,#4c9480)"></i>SOKLY6 · API</span><span><i style="border-color:var(--chart-3,#b27b35)"></i>kiruha355 · агент</span><span><i style="border-color:var(--chart-4,#8d69a7)"></i>kontar0 · TLC</span></div>''')
    parts.append(f'<figure><div class="toolbar"><a href="diagrams/{fig.slug}.svg">Отдельный SVG</a><button type="button" data-zoom="minus" aria-label="Уменьшить схему {escape(title)}">−</button><button type="button" data-zoom="reset">По ширине</button><button type="button" data-zoom="plus" aria-label="Увеличить схему {escape(title)}">+</button></div><div class="diagram" data-base="{fig.w}">{fig.svg()}</div><figcaption>{escape(fig.title)}.</figcaption></figure>')
    if slug=='analysis':parts.append('<p class="note">LLM не объявляет результат TLC сам. В текущем подписочном runtime нет автономного цикла с произвольными инструментами: следующий ход получает сохранённые требования и подходящий отчёт по hash модели.</p>')
    if slug=='storage':parts.append('<p class="note">Основной registry включает image_sources → image_analyses (007) и repository_snapshots → repository_files / repository_source_contexts (008). Изображение не притворяется текстовым Source; выбранные строки репозитория создают настоящий ограниченный Source.</p>')
    if slug=='codegen':parts.append('<p class="note">Генерация при неподтверждённом результате TLC требует явного allow_unverified в реализации. Эта продуктовая политика ещё не принята пользователем.</p>')
    if slug=='connections':parts.append('''<p class="note">Четыре MCP-инструмента: <code>get_model</code>, <code>check_behavior</code>, <code>get_tests</code>, <code>compare_with_code</code>. Последний проверяет точную сохранённую генерацию через штатную песочницу; произвольный код пока не поддерживается.</p><div class="status"><b>Граница интеграции.</b> Основные текстовый диалог, TLC, генерация и файлы связаны в PR63–66. PR67 (изображения), PR68 (MCP), PR69 (репозитории) и PR70 (launcher/CI) объединены в локальную поставку. Общая проверка: 513 backend PASS с настоящими TLC/Docker, frontend 36 PASS, extensions 108 PASS. Новые API не означают готовность клиентских экранов изображений/репозиториев. Корпусная оценка качества аналитика #30 и исследование мультиагентного ревью #42 не выдаются за готовые компоненты.</div>''')
    if slug=='delivery':parts.append('<p class="note">Схема CI показывает конфигурацию jobs, а не заявление о состоявшемся запуске всех этих jobs на GitHub. Локальные доказательства и непроверенные уровни перечислены в delivery/evidence.md.</p>')
    parts.append('</section>')
parts.append('''<section id="sources"><h2>Код и основания схем</h2><ul class="sources">
<li>Общий контракт: <code>src/proveryalka/behavior/*</code>, <code>verification/*</code>. Агент: <code>agent/dialogue.py</code>, <code>formalization.py</code>; ядро: <code>checker/engine.py</code>, <code>spec.py</code>, <code>parser.py</code>.</li>
<li>API и SQLite: <code>api/app.py</code>, <code>api/backend.py</code>, <code>storage/migrations/001…008</code>. Генерация: <code>codegen/service.py</code>, <code>storage/codegen.py</code>.</li>
<li>Новые блоки: <a href="../sokolov/images/integration-contract.md">изображения / PR67</a>, <a href="../sokolov/mcp/integration-contract.md">MCP / PR68</a>, <a href="../sokolov/repositories/integration-contract.md">репозитории / PR69</a>, <a href="../sokolov/delivery/integration-contract.md">delivery / PR70</a>.</li>
<li><a href="../decisions/explain.html">Принятые решения по клиенту</a> · <a href="diagrams.zip">Все семь схем в SVG</a>. Схемы описывают код и контракты, а не результат его слияния в GitHub.</li>
</ul></section><p class="foot">Текстовый сценарий, проверка модели и исполнение кода — разные этапы с отдельными результатами.</p></main></div></div>
<script>
const nav=document.querySelector('.toc details'),mq=matchMedia('(max-width:900px)');function fold(){nav.open=!mq.matches}fold();mq.addEventListener?.('change',fold);document.querySelectorAll('[data-zoom]').forEach(b=>b.addEventListener('click',()=>{const f=b.closest('figure'),d=f.querySelector('.diagram'),svg=d.querySelector('svg');let n=Number(d.dataset.scale||1);if(b.dataset.zoom==='reset'){d.dataset.scale='1';svg.style.width='100%';return}n=Math.max(.7,Math.min(2.2,n+(b.dataset.zoom==='plus' ? .2 : -.2)));d.dataset.scale=String(n);svg.style.width=Math.round(Number(d.dataset.base)*n)+'px';}));const links=[...document.querySelectorAll('.toc a')];const obs=new IntersectionObserver(es=>{for(const e of es)if(e.isIntersecting)links.forEach(a=>a.classList.toggle('active',a.hash==='#'+e.target.id))},{rootMargin:'-10% 0px -65% 0px'});document.querySelectorAll('main section[id]').forEach(s=>obs.observe(s));links.forEach(a=>a.addEventListener('click',()=>{if(mq.matches)nav.open=false}));
</script></body></html>''')
html=''.join(parts)
(ROOT/'explain.html').write_text(html)
with zipfile.ZipFile(ROOT/'diagrams.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
    for fig in figures:z.write(OUT/(fig.slug+'.svg'),fig.slug+'.svg')
print(f'{len(figures)} SVG; HTML {len(html)} characters')
