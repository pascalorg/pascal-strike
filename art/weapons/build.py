"""Splash armory, authored through Blender MCP. Units: metres, +Y forward, +Z up.
Run setup(), build_rifle(), build_pistol(), build_scraper(), then export_assets().
"""
import bpy, math, os, random
from mathutils import Vector
BASE = '/Users/wawa/Documents/Projects/pascal/pascal-strike'
M = {}; ROOTS = {}; ACTIVE = None

def material(name, color, rough=.38, metal=0, emission=0, alpha=1):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,alpha); m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value=(*color,alpha); bs.inputs['Roughness'].default_value=rough; bs.inputs['Metallic'].default_value=metal
    bs.inputs['Alpha'].default_value=alpha
    if emission: bs.inputs['Emission Color'].default_value=(*color,1); bs.inputs['Emission Strength'].default_value=emission
    if alpha<1: m.surface_render_method='DITHERED'
    return m

def setup():
    global M
    M={
      'cream':material('Ceramic ivory',(.79,.76,.66),.3),
      'navy':material('Midnight rubber',(.022,.031,.057),.48),
      'dark':material('Recess charcoal',(.006,.009,.014),.6),
      'metal':material('Brushed hardware',(.28,.32,.33),.28,.65),
      'team':material('TeamPaint',(.95,.19,.025),.26),
      'glass':material('TeamGlass',(1,.43,.11),.16,0,0,.22),
      'light':material('Status cyan',(.055,.85,.76),.22,0,1.4),
      'blue':material('Cobalt paint',(.025,.15,.72),.2),
      'yellow':material('Golden paint',(.97,.59,.035),.2),
    }
    bpy.context.scene.unit_settings.system='METRIC'

def root(kind):
    global ACTIVE
    col=bpy.data.collections.new('Splash / '+kind); bpy.context.scene.collection.children.link(col)
    obj=bpy.data.objects.new('Splash_'+kind,None); col.objects.link(obj); ROOTS[kind]=obj; ACTIVE=obj
    return obj

def finish(obj,name,mat,bevel=0,smooth=False):
    obj.name=name
    for col in list(obj.users_collection): col.objects.unlink(obj)
    ACTIVE.users_collection[0].objects.link(obj); obj.parent=ACTIVE
    if mat: obj.data.materials.append(M[mat])
    if bevel:
      for p in obj.data.polygons:p.use_smooth=True
      mod=obj.modifiers.new('Moulded radii','BEVEL'); mod.width=bevel; mod.segments=2
      mod=obj.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL'); mod.keep_sharp=True; mod.weight=50
    if smooth:
      for p in obj.data.polygons: p.use_smooth=True
    return obj

def box(name,loc,dims,mat,bevel=.003):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc); o=bpy.context.object
    o.dimensions=dims; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return finish(o,name,mat,bevel)

def profile(name,points,width,mat,bevel=.003,x=0):
    n=len(points); verts=[(side,y,z) for side in (x-width/2,x+width/2) for y,z in points]
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(verts,[],faces); mesh.update()
    o=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(o)
    # Consistent outward normals, regardless of the input silhouette winding.
    bpy.ops.object.select_all(action='DESELECT'); bpy.context.view_layer.objects.active=o; o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode='OBJECT'); o.select_set(False)
    return finish(o,name,mat,bevel)

def cylinder(name,loc,radius,depth,mat,axis='Z',radius2=None,verts=32):
    if radius2 is None: bpy.ops.mesh.primitive_cylinder_add(vertices=verts,radius=radius,depth=depth,location=loc)
    else: bpy.ops.mesh.primitive_cone_add(vertices=verts,radius1=radius,radius2=radius2,depth=depth,location=loc)
    o=bpy.context.object
    if axis=='Y': o.rotation_euler.x=math.pi/2
    if axis=='X': o.rotation_euler.y=math.pi/2
    return finish(o,name,mat,.0012,True)

def ring(name,loc,outer,inner,depth,mat,axis='Y',segments=40):
    vertices=[]
    for z,r in [(-depth/2,outer),(depth/2,outer),(-depth/2,inner),(depth/2,inner)]:
      for i in range(segments):
        a=i*2*math.pi/segments; vertices.append((r*math.cos(a),r*math.sin(a),z))
    faces=[]
    for a,b in [(0,1),(3,2),(1,3),(2,0)]:
      for i in range(segments):
        j=(i+1)%segments; faces.append((a*segments+i,a*segments+j,b*segments+j,b*segments+i))
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(vertices,[],faces); mesh.update(); o=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(o); o.location=loc
    if axis=='Y':o.rotation_euler.x=math.pi/2
    if axis=='X':o.rotation_euler.y=math.pi/2
    return finish(o,name,mat,.001,True)

def sphere(name,loc,scale,mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,location=loc);o=bpy.context.object;o.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return finish(o,name,mat,0,True)

def tube(name,points,radius,mat):
    curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.resolution_u=5;curve.bevel_depth=radius;curve.bevel_resolution=2
    spline=curve.splines.new('BEZIER');spline.bezier_points.add(len(points)-1)
    for b,co in zip(spline.bezier_points,points):b.co=co;b.handle_left_type='AUTO';b.handle_right_type='AUTO'
    o=bpy.data.objects.new(name,curve);bpy.context.collection.objects.link(o);return finish(o,name,mat)

def bolt(x,y,z,r=.004):
    cylinder('Captive screw',(x,y,z),r,.0015,'metal','X',verts=16)
    box('Screw slot',(x+( .001 if x>0 else -.001),y,z),(.001,r*1.15,.0008),'dark',.0002)

def label(text,x,y,z,size,mat='cream'):
    curve=bpy.data.curves.new('Marking '+text,'FONT');curve.body=text;curve.size=size;curve.align_x='CENTER';curve.extrude=.00012;curve.resolution_u=4
    o=bpy.data.objects.new('Marking '+text,curve);bpy.context.collection.objects.link(o);o.location=(x,y,z)
    # Text runs from front to back on right side, and is mirrored onto the left panel.
    from mathutils import Matrix
    horizontal=Vector((0,1 if x>0 else -1,0));up=Vector((0,0,1));normal=horizontal.cross(up)
    o.rotation_euler=Matrix((horizontal,up,normal)).transposed().to_euler()
    return finish(o,o.name,mat)

def splat(x,y,z,r,mat='team',seed=7):
    rand=random.Random(seed);points=[]
    for i in range(32):
      a=math.tau*i/32;radius=r*(.52+rand.random()*.18 if i%2 else .9+rand.random()*.1);points.append((y+math.cos(a)*radius,z+math.sin(a)*radius))
    profile('Paint insignia',points,.0006,mat,0,x)
    for i in range(5):
      a=rand.random()*math.tau;sphere('Paint fleck',(x,y+math.cos(a)*r*1.2,z+math.sin(a)*r*1.2),(.0005,r*.07,r*.09),mat)

def socket(name,loc):
    o=bpy.data.objects.new(name,None);ACTIVE.users_collection[0].objects.link(o);o.parent=ACTIVE;o.location=loc;return o

def build_rifle():
    root('rifle')
    profile('Sculpted receiver',[(-.115,.005),(-.115,.075),(-.08,.098),(.305,.098),(.33,.073),(.33,-.005),(.18,-.02),(.11,-.014),(.005,-.005),(-.022,.005)],.07,'cream',.008)
    # The compact, open stock balances the large forward hopper.
    box('Stock slide',(0,-.15,.044),(.055,.10,.040),'navy',.005)
    box('Orange cheek rest',(0,-.206,.047),(.057,.103,.059),'team',.006)
    box('Rubber butt',(0,-.265,.005),(.061,.025,.147),'navy',.009)
    profile('Stock lower brace',[(-.255,-.060),(-.247,-.071),(-.17,-.018),(-.13,-.01),(-.13,.006),(-.177,-.004)],.029,'navy',.003)
    for i in range(5):box('Butt tread',(0,-.279,-.043+i*.021),(.052,.002,.003),'dark',.0006)
    # Broad front receiver panel, raised light strip and hardware.
    for sign in [-1,1]:
      profile('Orange forebody insert',[(.162,.059),(.297,.059),(.304,.046),(.294,-.035),(.175,-.032)],.005,'team',.005,sign*.037)
      box('Cyan status rail',(sign*.037,.16,.082),(.003,.273,.005),'light',.002)
      for y,z in [(.30,.066),(.145,.00),(-.079,.059)]:bolt(sign*.039,y,z,.0032)
      splat(sign*.0366,-.015,.045,.018,'navy',19)
      for j in range(3):
        y=-.08+j*.016
        profile('Chevron',[(y-.009,.041),(y,.050),(y-.006,.060),(y+.001,.063),(y+.010,.050),(y-.001,.037)],.0012,'navy',.0003,sign*.0368)
      label('SPLASH / 01',sign*.040,.22,.008,.011)
    # Swept pistol grip and its orange shoe.
    profile('Rubber palm swell',[(-.034,.01),(.012,-.007),(-.004,-.047),(-.038,-.123),(-.081,-.108),(-.058,-.036)],.042,'navy',.009)
    profile('Grip heel',[(-.082,-.112),(-.038,-.128),(-.034,-.117),(-.077,-.101)],.045,'team',.003)
    for sign in [-1,1]:
      for i in range(5):tube('Grip rib',[(sign*.023,-.035-i*.006,-.04-i*.013),(sign*.022,-.005-i*.006,-.05-i*.013)],.0011,'dark')
    # Open trigger guard, visibly separate from the grip.
    tube('Trigger guard',[(0,.006,-.003),(0,.100,-.003),(0,.107,-.041),(0,.088,-.064),(0,.025,-.064),(0,.012,-.040)],.004,'navy')
    profile('Orange trigger',[(.055,-.008),(.065,-.010),(.059,-.047),(.048,-.048),(.054,-.027)],.009,'team',.002)
    profile('Magazine collar',[(.106,-.007),(.157,-.009),(.142,-.039),(.092,-.034)],.060,'cream',.003)
    profile('Curved magazine',[(.104,-.028),(.149,-.034),(.166,-.135),(.116,-.145),(.095,-.130)],.046,'cream',.006)
    for sign in [-1,1]:profile('Magazine paint window',[(.111,-.041),(.14,-.044),(.153,-.125),(.121,-.131),(.108,-.12)],.002,'team',.003,sign*.024)
    # Flared cream muzzle with a dark recessed bore and orange annulus.
    cylinder('Barrel collar',(0,.336,.05),.029,.022,'navy','Y')
    cylinder('Muzzle flare',(0,.382,.05),.030,.072,'cream','Y',.044)
    ring('Muzzle lip',(0,.42,.05),.044,.022,.009,'cream')
    ring('Paint nozzle',(0,.421,.05),.022,.013,.010,'team')
    cylinder('Deep bore',(0,.411,.05),.013,.003,'dark','Y')
    # Ribbed spine and hopper clamp.
    box('Top rail',(0,.105,.105),(.032,.366,.009),'navy',.001)
    for i in range(15):box('Rail lug',(0,-.067+i*.022,.112),(.040,.011,.009),'navy',.001)
    profile('Front blade sight',[(.283,.112),(.314,.112),(.315,.143),(.308,.149),(.294,.138)],.018,'navy',.002)
    box('Sight dot',(0,.314,.136),(.007,.003,.006),'light',.001)
    box('Hopper saddle',(0,.072,.124),(.086,.092,.018),'navy',.004)
    box('Hopper riser',(0,.154,.149),(.038,.025,.074),'navy',.004)
    glass=box('Paint reservoir shell',(0,.051,.198),(.104,.205,.098),'glass',.033)
    fill=box('Reservoir liquid',(0,.051,.179),(.091,.188,.058),'team',.023)
    level=socket('PaintLevel',(0,.051,.151));fill.parent=level;fill.location-=level.location
    cylinder('Refill cap',(0,.160,.197),.034,.014,'navy','Y')
    for sign in [-1,1]:
      ring('Pressure rim',(sign*.052,.057,.198),.017,.013,.003,'metal','X',32)
      cylinder('Pressure face',(sign*.054,.057,.198),.0127,.001,'cream','X')
      for i in range(6):
        a=math.pi*.15+i*math.pi*.14;y=.057+math.cos(a)*.009;z=.198+math.sin(a)*.009
        box('Gauge tick',(sign*.055,y,z),(.0007,.0014,.0016),'navy',0)
      tube('Gauge needle',[(sign*.0556,.057,.198),(sign*.0556,.051,.203)],.0007,'navy')
      tube('Tank highlight',[(sign*.045,.112,.224),(sign*.047,.07,.229),(sign*.042,.012,.229)],.002,'cream')
    socket('Muzzle',(0,.427,.05));socket('Grip',(0,0,0))
    ACTIVE['length']=.71;ACTIVE['reference']='Image 1 / Splash main marker'
    print('Rifle authored:',len(ACTIVE.children),'parts')

def build_pistol():
    root('pistol')
    profile('Sidearm shell',[(-.074,.017),(-.078,.085),(-.063,.116),(-.018,.121),(.012,.099),(.193,.099),(.207,.080),(.206,-.027),(.099,-.030),(.057,-.009),(-.039,-.014)],.063,'cream',.009)
    for sign in [-1,1]:
      profile('Sidearm orange panel',[(.021,.069),(.184,.069),(.188,.052),(.183,-.036),(.123,-.036),(.104,.00),(-.003,.00)],.004,'team',.005,sign*.033)
      box('Sidearm cyan rail',(sign*.033,.100,.086),(.002,.19,.004),'light',.0018)
      for i in range(3):
        groove=box('Slide relief',(sign*.032,-.043+i*.018,.066),(.003,.006,.033),'metal',.002)
        groove.rotation_euler.x=.35
      for y,z in [(.179,.059),(.034,.057),(-.049,.023)]:bolt(sign*.036,y,z,.003)
      splat(sign*.036,.142,.027,.022,'light',23)
      label('SPLASH',sign*.038,.136,.028,.009,'navy'); label('3000',sign*.038,.136,.016,.012,'navy')
      label('SPLASH 3000',sign*.036,.059,.014,.006)
      box('Safety paddle',(sign*.034,-.014,-.002),(.005,.026,.007),'team',.002)
    cylinder('Sidearm muzzle throat',(0,.213,.040),.021,.020,'navy','Y')
    cylinder('Sidearm flared nozzle',(0,.237,.040),.028,.041,'cream','Y',.038)
    ring('Sidearm muzzle lip',(0,.258,.040),.038,.024,.008,'cream')
    ring('Sidearm orange bore',(0,.259,.040),.024,.014,.007,'team')
    cylinder('Sidearm bore shadow',(0,.248,.040),.014,.002,'dark','Y')
    # Rear notch and tall front post.
    box('Rear sight',(0,-.060,.124),(.036,.013,.013),'navy',.002)
    box('Sight notch',(0,-.060,.129),(.009,.016,.007),'dark',.0005)
    box('Front sight',(0,.173,.106),(.008,.022,.010),'navy',.001)
    sphere('Front sight cyan bead',(0,.166,.11),(.003,.003,.003),'light')
    profile('Sidearm rubber grip',[(-.038,.003),(.006,-.010),(-.002,-.042),(-.031,-.137),(-.081,-.120),(-.062,-.038)],.044,'navy',.007)
    for sign in [-1,1]:
      profile('Grip orange badge',[(-.018,-.064),(-.034,-.112),(-.053,-.109),(-.039,-.059)],.0025,'team',.003,sign*.023)
      for i in range(6):box('Grip badge ribs',(sign*.025,-.035-i*.0015,-.07-i*.005),(.001,.012,.0014),'navy',.0002)
    for i in range(5):tube('Finger grooves',[(-.019,-.002-i*.006,-.035-i*.016),(0,-.000-i*.006,-.038-i*.016),(.019,-.002-i*.006,-.035-i*.016)],.0018,'dark')
    profile('Grip ivory base',[(-.083,-.123),(-.027,-.140),(-.025,-.132),(-.08,-.115)],.048,'cream',.003)
    profile('Exposed paint magazine',[(-.078,-.130),(-.032,-.146),(-.026,-.160),(-.073,-.145)],.039,'team',.003)
    profile('Magazine bumper',[(-.077,-.15),(-.024,-.167),(-.020,-.157),(-.074,-.140)],.05,'team',.003)
    tube('Ivory trigger guard',[(0,.006,-.017),(0,.087,-.018),(0,.087,-.054),(0,.067,-.068),(0,.024,-.061),(0,.01,-.040)],.0045,'cream')
    profile('Sidearm trigger',[(.048,-.017),(.059,-.02),(.050,-.052),(.041,-.051)],.008,'team',.002)
    # Small forward paint vial; its liquid remains a separate animated part.
    cylinder('Vial connector',(0,.16,-.041),.020,.022,'navy')
    vial=box('Sidearm vial glass',(0,.165,-.095),(.044,.048,.091),'glass',.012)
    fill=box('Sidearm vial liquid',(0,.165,-.105),(.035,.039,.064),'team',.008)
    level=socket('PaintLevel',(0,.165,-.137));fill.parent=level;fill.location-=level.location
    box('Vial bottom',(0,.165,-.144),(.046,.05,.009),'team',.003)
    for sign in [-1,1]:
      box('Vial measure',(sign*.023,.165,-.096),(.0012,.005,.059),'navy',.002)
      for i in range(5):box('Vial graduation',(sign*.024,.155,-.12+i*.012),(.001,.004,.001),'cream',.0002)
    socket('Muzzle',(0,.265,.04));socket('Grip',(0,0,0));ACTIVE['length']=.346
    ACTIVE['reference']='Image 2 / Splashblaster 3000 sidearm'
    print('Pistol authored:',len(ACTIVE.children),'parts')

def build_scraper():
    root('knife')
    cylinder('Scraper rubber handle',(0,-.020,0),.017,.135,'navy','Y')
    cylinder('Ivory pommel',(0,-.094,0),.019,.020,'cream','Y')
    cylinder('Orange pommel band',(0,-.081,0),.019,.006,'team','Y')
    sphere('Cyan pommel light',(0,-.107,0),(.007,.004,.007),'light')
    cylinder('Orange ferrule',(0,.054,0),.021,.017,'team','Y')
    cylinder('Ivory scraper neck',(0,.104,0),.014,.087,'cream','Y')
    # Raised diamond rubber texture, real geometry readable in first person.
    for side in [-1,1]:
      for row in range(6):
        y=-.071+row*.021
        tube('Grip diamond',[(-.012,y,side*.012),(0,y+.009,side*.017),(.012,y,side*.012)],.0007,'dark')
        tube('Grip diamond',[(-.012,y,side*.012),(0,y-.009,side*.017),(.012,y,side*.012)],.0007,'dark')
    from mathutils import Matrix
    orientation=Matrix(((0,1,0,0),(0,0,1,0),(1,0,0,0),(0,0,0,1)))
    def blade(name,points,thickness,mat,bevel=.004):
      o=profile(name,points,thickness,mat,bevel);o.data.transform(orientation);return o
    blade('Moulded scraper head',[(-.090,.138),(.071,.138),(.093,.152),(.116,.234),(.108,.251),(-.103,.239),(-.116,.218),(-.111,.161)],.021,'cream',.008)
    blade('Inset blade face',[(-.078,.149),(.063,.149),(.080,.160),(.099,.226),(-.095,.215),(-.098,.170)],.024,'cream',.004)
    blade('Paint soaked edge',[(-.111,.216),(-.108,.241),(.110,.254),(.118,.235),(.097,.219),(.070,.225),(.049,.213),(.02,.220),(-.018,.207),(-.045,.214),(-.076,.204)],.027,'team',.005)
    # Soft, asymmetric paint drips wrap over both faces of the scraper.
    for side in [-1,1]:
      for x,y,length,r in [(-.073,.226,.039,.005),(.071,.236,.051,.006),(.023,.231,.027,.004),(-.015,.224,.014,.003)]:
        tube('Wet paint drip',[(x,y,side*.014),(x+.003,y-length*.48,side*.014),(x+.001,y-length,side*.016)],r,'team')
        sphere('Rounded paint drop',(x+.001,y-length,side*.016),(r*1.22,r*1.35,r*.68),'team')
      tube('Cobalt paint streak',[(-.088,.231,side*.016),(-.057,.233,side*.017),(-.040,.225,side*.016)],.005,'blue')
      sphere('Cobalt droplet',(-.033,.215,side*.017),(.003,.006,.002),'blue')
      tube('Golden paint streak',[(.036,.247,side*.015),(.066,.249,side*.016),(.088,.244,side*.016)],.003,'yellow')
      # Small neck paint dots.
      for i in range(4):sphere('Neck paint fleck',(-.007+i*.004,.105+i*.006,side*.013),(.003,.004,.001),'team' if i%2 else 'light')
    socket('Muzzle',(0,.255,0));socket('Grip',(0,0,0));ACTIVE['length']=.366
    turn=Matrix.Rotation(math.pi/2,4,'X')
    for part in ACTIVE.children:part.matrix_basis=turn@part.matrix_basis
    ACTIVE['reference']='Image 3 / paint scraper melee'
    print('Scraper authored:',len(ACTIVE.children),'parts')

def export_assets():
    """Evaluate modifiers into temporary meshes; keep the editable source parts in the .blend."""
    import json
    output=os.path.join(BASE,'public/weapons');os.makedirs(output,exist_ok=True)
    report={}
    for kind,asset in ROOTS.items():
      collection=bpy.data.collections.new('EXPORT '+kind);bpy.context.scene.collection.children.link(collection)
      export_root=bpy.data.objects.new('Splash_'+kind+'_GLB',None);collection.objects.link(export_root)
      export_root['length']=asset['length'];export_root['source']='Blender / splash-armory.blend'
      level_source=next((o for o in asset.children if o.name.startswith('PaintLevel')),None)
      level=None
      if level_source:
        level=bpy.data.objects.new('PaintLevel_export',None);collection.objects.link(level);level.parent=export_root;level.location=level_source.location
      bpy.context.view_layer.update();depsgraph=bpy.context.evaluated_depsgraph_get()
      batches={False:[],True:[]}
      for original in asset.children_recursive:
        if original.type not in {'MESH','CURVE','FONT'}:continue
        evaluated=original.evaluated_get(depsgraph)
        mesh=bpy.data.meshes.new_from_object(evaluated,preserve_all_data_layers=True,depsgraph=depsgraph)
        obj=bpy.data.objects.new(original.name+'_baked',mesh);collection.objects.link(obj)
        liquid=original.parent==level_source and level_source is not None
        matrix=asset.matrix_world.inverted()@original.matrix_world
        if liquid: matrix.translation-=level_source.location
        mesh.transform(matrix);obj.parent=level if liquid else export_root
        batches[liquid].append(obj)
      for liquid,objects in batches.items():
        if not objects:continue
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();objects[0].name='PaintFill' if liquid else 'Shell'
      muzzle_source=next(o for o in asset.children if o.name.startswith('Muzzle'))
      muzzle=bpy.data.objects.new('Muzzle_export',None);collection.objects.link(muzzle);muzzle.parent=export_root;muzzle.location=muzzle_source.location
      grip=bpy.data.objects.new('Grip_export',None);collection.objects.link(grip);grip.parent=export_root
      bpy.ops.object.select_all(action='DESELECT')
      for obj in collection.objects:obj.select_set(True)
      filepath=os.path.join(output,kind+'.glb')
      bpy.ops.export_scene.gltf(filepath=filepath,export_format='GLB',use_selection=True,export_yup=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False)
      triangles=0
      for obj in collection.objects:
        if obj.type=='MESH':obj.data.calc_loop_triangles();triangles+=len(obj.data.loop_triangles)
      report[kind]={'bytes':os.path.getsize(filepath),'triangles':triangles,'length':asset['length'],'muzzle_blender':list(muzzle.location)}
      for obj in list(collection.objects):
        mesh=obj.data if obj.type=='MESH' else None;bpy.data.objects.remove(obj,do_unlink=True)
        if mesh and mesh.users==0:bpy.data.meshes.remove(mesh)
      bpy.data.collections.remove(collection)
    with open(os.path.join(BASE,'art/weapons/export-report.json'),'w') as f:json.dump(report,f,indent=2)
    print(json.dumps(report))

def render_preview(kind):
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
    scene.render.resolution_x=1200;scene.render.resolution_y=850;scene.render.resolution_percentage=100
    scene.world.color=(.2,.2,.2)
    scene.view_settings.view_transform='AgX';scene.view_settings.exposure=-1.3
    studio=bpy.data.collections.get('Preview studio')
    if not studio:
      studio=bpy.data.collections.new('Preview studio');scene.collection.children.link(studio)
      data=bpy.data.cameras.new('Product camera');camera=bpy.data.objects.new('Product camera',data);studio.objects.link(camera);scene.camera=camera
      for name,loc,power,size,color in [('Key',(1,0,1.5),130,1.3,(1,.88,.74)),('Fill',(-.6,.8,.7),95,1.1,(.68,.84,1)),('Rim',(.3,-1,.8),170,.8,(1,1,1))]:
        data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=color
        obj=bpy.data.objects.new(name,data);studio.objects.link(obj);obj.location=loc;obj.rotation_euler=(Vector((0,.06,.04))-obj.location).to_track_quat('-Z','Y').to_euler()
    for k,asset in ROOTS.items():asset.users_collection[0].hide_render=k!=kind
    camera=scene.camera
    target=Vector((0,.07,.04 if kind=='rifle' else 0))
    camera.location=(1.2,.7,.46) if kind!='knife' else (.40,-.70,.42)
    camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=.88 if kind=='rifle' else .50
    scene.render.film_transparent=True
    folder=os.path.join(BASE,'art/weapons/previews');os.makedirs(folder,exist_ok=True)
    scene.render.filepath=os.path.join(folder,kind+'.png');bpy.ops.render.render(write_still=True)

if __name__=='__main__':
    setup();build_rifle();build_pistol();build_scraper();export_assets()
