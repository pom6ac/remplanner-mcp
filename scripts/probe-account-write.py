# Проверка записи в проект аккаунта <OID> по HTTP: копия → запись → GET → восстановление → сверка.
# Плюс: выбивает ли второй вход первую сессию; поведение при устаревшем save_id.
# Логин, пароль и authkey не выводятся. Запускать только с разрешения координатора.
import http.cookiejar, json, os, re, subprocess, sys, urllib.parse, urllib.request

OID, PID = '<OID>', '<PID>'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.join(ROOT, '.orca-reports', 'backup-<OID>-before.json')
creds = {}
for line in open(os.path.expanduser('~/.remplanner-mcp/credentials.env'), encoding='utf-8'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.strip().split('=', 1)
        creds[k] = v.strip().strip('"\'')

def session():
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [('User-Agent', 'Mozilla/5.0 (Macintosh) remplanner-mcp-discovery'), ('Referer', 'https://remplanner.ru/planner/')]
    return op

def req(op, url, data=None):
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    with op.open(url, body, timeout=30) as r:
        return r.geturl(), r.read().decode('utf-8', 'ignore')

def login(op):
    req(op, 'https://remplanner.ru/client/')
    _, page = req(op, 'https://remplanner.ru/client/', {'auth_trigger': '1', 'email': creds['REMPLANNER_LOGIN'], 'password': creds['REMPLANNER_PASSWORD']})
    return 'is_logged' in page

def logged(op):
    return 'is_logged' in req(op, 'https://remplanner.ru/client/')[1]

def load(op):
    url, txt = req(op, f'https://remplanner.ru/setup/api/planner/?object_id={OID}&plan_id={PID}')
    if '/client/?out=1' in url:
        raise SystemExit('сессия выбита при load')
    return json.loads(txt)

def save(op, authkey, data_str, save_id, forced):
    q = urllib.parse.urlencode({'object_id': OID, 'plan_id': PID, 'plan': 'a', 'authkey': authkey, 'save_id': save_id, 'is_resave': 0, 'is_forced': forced})
    _, txt = req(op, 'https://remplanner.ru/setup/api/planner/save/?' + q, {
        'plan_length': len(data_str), 'session': '34567', 'version': '757', 'save_id': save_id,
        'planner_version': '3', 'is_zip': '0', 'plan_data': data_str})
    try:
        r = json.loads(txt)
    except Exception:
        return {'_raw': txt[:200]}
    r.pop('direct', None)
    return r

A = session(); B = session()
print('login A:', login(A))
print('A logged before B:', logged(A))
print('login B:', login(B))
a_after, b_after = logged(A), logged(B)
print('after B login -> A logged:', a_after, '| B logged:', b_after)
op = B if b_after else A

# открыть проект и взять authkey/save_id из страницы редактора
req(op, 'https://remplanner.ru/client/')
_, cab = req(op, 'https://remplanner.ru/client/')
link = re.search(r'/planner/oid' + OID + r'o\d+/', cab).group(0)
_, ed = req(op, 'https://remplanner.ru' + link)
authkey = re.search('data-authk' + 'ey="([^"]*)"', ed).group(1)
print('editor opened, authkey len', len(authkey), 'plan_id', re.search(r'data-plan_id="(\d*)"', ed).group(1))

backup = json.load(open(BACKUP))
cur = load(op)
print('current == backup:', cur['data'] == backup['data'], 'save_id', cur['save_id'])
if cur['data'] != backup['data']:
    raise SystemExit('модель уже отличается от копии — стоп, ничего не пишу')

test = subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'scripts', 'build-test-model.py'), OID, PID], capture_output=True, text=True, check=True).stdout.strip()
r1 = save(op, authkey, test, cur['save_id'], 1)
print('write test:', r1)
after = load(op)
print('GET after write == test model:', after['data'] == test, 'save_id', after['save_id'])

# устаревший save_id без is_forced (пишем исходные данные — безопасно)
r_stale = save(op, authkey, backup['data'], cur['save_id'], 0)
print('stale save_id, is_forced=0:', r_stale)
mid = load(op)
print('after stale save: data==backup', mid['data'] == backup['data'], 'data==test', mid['data'] == test, 'save_id', mid['save_id'])

if mid['data'] != backup['data']:
    r2 = save(op, authkey, backup['data'], mid['save_id'], 1)
    print('restore:', r2)
final = load(op)
print('FINAL data == backup:', final['data'] == backup['data'], 'save_id', final['save_id'])
json.dump({k: v for k, v in final.items() if k != 'direct'}, open(os.path.join(ROOT, '.orca-reports', 'backup-<OID>-after.json'), 'w'), ensure_ascii=False)
print('A still logged at end:', logged(A), '| B:', logged(B))
