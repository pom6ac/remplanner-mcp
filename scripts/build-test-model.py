# Строит минимальную модель remplanner (формат project.copy("server")): комната 400x300 см по оси стен,
# стены 20 см, дверь 80 см на нижней стене, окно 120 см на верхней. Координаты в см (внутренние единицы редактора).
import json, sys, random, string
def rid(): return ''.join(random.choice(string.ascii_lowercase+string.digits) for _ in range(10))
oid, pid = sys.argv[1], sys.argv[2]
pts=[(0,0),(400,0),(400,300),(0,300)]
ids=[rid() for _ in pts]
walls={}
for i,(a,b) in enumerate(zip(pts, pts[1:]+pts[:1])):
    walls[ids[i]]={"id":ids[i],"plan":"a","role":"wall","child":0,"archive":0,"demount":0,"depth":20,"height":270,
      "p1":{"x":a[0],"y":a[1],"link":{"ct":"node","ot":"wall","id":ids[i-1],"z0":"p2","z1":"p1"}},
      "p2":{"x":b[0],"y":b[1],"link":{"ct":"node","ot":"wall","id":ids[(i+1)%4],"z0":"p1","z1":"p2"}},
      "p1st":0,"p2st":0,"material":"a_block","color":0,"level":"1","show_dls":True,"holes":{}}
d=rid(); w=rid()
walls[ids[0]]["holes"][w]={"id":w,"plan":"a","type":"window","group":"windows","pc":{"x":200,"y":0},"width":120,"height":150,"depth":10,"floor_height":80}
walls[ids[2]]["holes"][d]={"id":d,"plan":"a","type":"single","group":"doors","pc":{"x":200,"y":300},"width":80,"height":200,"depth":4,"opening":"r-l"}
model={"v":3,"id":oid,"plan_id":pid,"walls":walls,"items":{},"pillars":{},"rulers":{},"comments":{},"total_height":270,"final":True}
print(json.dumps(model,separators=(',',':')))
