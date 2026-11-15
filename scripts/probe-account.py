# Разведка личного кабинета по HTTP (только чтение): вход формой /client/, разбор страницы ЛК.
# Логин и пароль читаются из ~/.remplanner-mcp/credentials.env и никуда не выводятся.
# Выход: обезличенная структура ЛК в stdout и сырой HTML в $TMPDIR (вне репозитория).
import http.cookiejar, os, re, sys, html, urllib.parse, urllib.request, json

HOME = os.path.expanduser('~/.remplanner-mcp')
creds = {}
for line in open(os.path.join(HOME, 'credentials.env'), encoding='utf-8'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    creds[k.strip()] = v.strip().strip('"').strip("'")
login, password = creds.get('REMPLANNER_LOGIN'), creds.get('REMPLANNER_PASSWORD')
if not login or not password:
    sys.exit('credentials.env: нет REMPLANNER_LOGIN/REMPLANNER_PASSWORD')

jar_path = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'rp', 'state.cookies.txt')
jar = http.cookiejar.MozillaCookieJar(jar_path)
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [('User-Agent', 'Mozilla/5.0 (Macintosh) remplanner-mcp-discovery'), ('Referer', 'https://remplanner.ru/client/')]

def get(url):
    with opener.open(url, timeout=20) as r:
        return r.status, r.geturl(), r.read().decode('utf-8', 'ignore')

def post(url, data):
    body = urllib.parse.urlencode(data).encode()
    with opener.open(url, body, timeout=20) as r:
        return r.status, r.geturl(), r.read().decode('utf-8', 'ignore')

get('https://remplanner.ru/client/')
# auth_trigger=1 — то же значение, что выставляет JS страницы любому посетителю
st, url, page = post('https://remplanner.ru/client/', {'auth_trigger': '1', 'email': login, 'password': password})
logged = 'is_logged' in page or 'client/?out=1' in page
print('login_status', st, 'final_url_path', urllib.parse.urlparse(url).path, 'logged', logged)
jar.save(ignore_discard=True, ignore_expires=True)
os.chmod(jar_path, 0o600)
tmp = os.environ.get('TMPDIR', '/tmp')
open(os.path.join(tmp, 'rp', 'client_logged.html'), 'w').write(page.replace(login, '[login]'))
if not logged:
    sys.exit('вход не подтверждён')

def clean(s):
    s = re.sub(r'(?s)<(script|style).*?</\1>', '', s)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s))).strip()

masked = page.replace(login, '[login]')
txt = clean(masked)
for kw in ['тариф', 'Тариф', 'PRO', 'лимит', 'проект']:
    for m in list(re.finditer(kw, txt))[:3]:
        print('ctx', kw, '…', txt[max(0, m.start()-80):m.start()+120])
print('hrefs', sorted(set(h for h in re.findall(r'href="([^"#]+)"', masked) if h.startswith('/') and not h.startswith('/files/')))[:80])
print('onclick', sorted(set(re.findall(r'onclick="([a-zA-Z_]+)\(', masked))))
print('forms', re.findall(r'<form[^>]*>', masked)[:10])
print('planner_links', len(re.findall(r'/planner/\?', masked)), sorted(set(re.findall(r'/planner/\?[a-z_]+=', masked))))
EOF_MARK = None
