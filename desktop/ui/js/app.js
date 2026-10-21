(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const PERMS = [
    ['items.view','View items'],['items.manage','Manage items and categories'],['suppliers.view','View suppliers'],['suppliers.manage','Manage suppliers'],
    ['purchases.view','View purchases'],['purchases.manage','Create and cancel purchases'],['purchases.receive','Receive purchases'],
    ['issues.view','View office issues'],['issues.manage','Issue and cancel stock'],['stock.view','View stock and movements'],['stock.adjust','Correct stock'],
    ['reports.view','View reports'],['requests.review','Review branch requests'],['requests.create','Create branch requests'],
    ['dispatches.manage','Create and close dispatches'],['dispatches.receive','Receive dispatches'],['petty_cash.view','View petty cash'],
    ['petty_cash.approve','Approve petty cash'],['petty_cash.configure','Set low cash level'],['petty_cash.request','Request and record petty cash']
  ];
  const NAV = [
    {id:'dashboard',label:'Overview',icon:'◫'}, {id:'items',label:'Items',icon:'▣',p:'items.view'},
    {id:'suppliers',label:'Suppliers',icon:'♧',e:['suppliers.view','purchases.view']}, {id:'purchases',label:'Purchases',icon:'▤',p:'purchases.view'},
    {id:'issues',label:'Office issues',icon:'↗',p:'issues.view'}, {id:'stock',label:'Stock & movements',icon:'▥',p:'stock.view'},
    {id:'requests',label:'Branch requests',icon:'⇄',e:['requests.create','requests.review'],module:'branch'},
    {id:'dispatches',label:'Dispatches',icon:'➜',e:['dispatches.manage','dispatches.receive'],module:'branch'},
    {id:'petty_cash',label:'Petty cash',icon:'¤',e:['petty_cash.request','petty_cash.view']},
    {id:'reports',label:'Reports',icon:'▧',p:'reports.view'},
    {id:'branches',label:'Branches',icon:'⌂',admin:true},{id:'users',label:'Users',icon:'♙',admin:true},
    {id:'roles',label:'Roles',icon:'⛨',admin:true},{id:'audit',label:'Audit log',icon:'◷',admin:true},{id:'settings',label:'Settings',icon:'⚙',admin:true}
  ];
  let cfg=null, api=null, profile=null, role=null, branch=null, settings=null, screen='dashboard', pendingAuthCallback=null;
  const localDateISO = (value=new Date()) => [value.getFullYear(),String(value.getMonth()+1).padStart(2,'0'),String(value.getDate()).padStart(2,'0')].join('-');
  let reportState={type:'balances',from:localDateISO(new Date(new Date().getFullYear(),new Date().getMonth(),1)),to:localDateISO(),by:'supplier',branch:'',supplier:'',department:'',low:false};
  const cache=Object.create(null);
  function applySupabaseCsp(url) {
    const origin=new URL(url).origin;
    let policy=$('meta[data-supabase-csp]');
    if(!policy){policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.dataset.supabaseCsp='1';document.head.appendChild(policy);}
    policy.content="default-src 'self'; connect-src 'self' "+origin+"; object-src 'none'; frame-ancestors 'none'; form-action 'self';";
  }
  const esc = v => String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = v => v ? new Date(String(v).slice(0,10)+'T00:00:00').toLocaleDateString() : '—';
  const time = v => v ? new Date(v).toLocaleString() : '—';
  const cash = v => 'Rs. '+Number(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const admin = () => profile && profile.role_key==='super_admin';
  const perms = () => admin()?PERMS.map(x=>x[0]):(Array.isArray(profile&&profile.permissions)?profile.permissions:(role&&role.permissions)||[]);
  const has = p => admin() || perms().indexOf(p)>=0;
  const allowed = n => (n.module!=='branch'||!!(settings&&settings.branch_module_enabled))&&(n.admin?admin():n.p?has(n.p):n.e?n.e.some(has):true);
  const btn = (label,action,cls,id) => '<button class="'+(cls||'btn btn-secondary')+'" type="button" data-action="'+esc(action)+'" '+(id!=null?'data-id="'+esc(id)+'"':'')+'>'+esc(label)+'</button>';
  const field = (name,label,opt={}) => {
    let input='';
    const req=opt.required?' required':'';
    if(opt.options) input='<select name="'+esc(name)+'"'+req+'>'+opt.options.map(o=>'<option value="'+esc(o.value)+'" '+(String(o.value)===String(opt.value)?'selected':'')+'>'+esc(o.label)+'</option>').join('')+'</select>';
    else if(opt.type==='textarea') input='<textarea name="'+esc(name)+'"'+req+' placeholder="'+esc(opt.placeholder||'')+'">'+esc(opt.value||'')+'</textarea>';
    else input='<input name="'+esc(name)+'" type="'+esc(opt.type||'text')+'" value="'+esc(opt.value||'')+'"'+req+(opt.min!=null?' min="'+esc(opt.min)+'"':'')+(opt.step?' step="'+esc(opt.step)+'"':'')+' placeholder="'+esc(opt.placeholder||'')+'" autocomplete="'+(opt.type==='password'?'new-password':'off')+'">';
    return '<div class="field '+(opt.wide?'span-2':'')+'"><label class="lbl">'+esc(label)+(opt.required?' *':'')+'</label>'+input+(opt.help?'<small class="muted">'+esc(opt.help)+'</small>':'')+'</div>';
  };
  const page = (title,desc,body,actions) => '<div class="page-header"><div><h1>'+esc(title)+'</h1><p>'+esc(desc||'')+'</p></div><div class="actions">'+(actions||'')+'</div></div>'+body;
  const card = (title,body) => '<section class="card"><div class="card-head"><h2>'+esc(title)+'</h2></div><div class="card-body">'+body+'</div></section>';
  const table = (heads,rows) => '<div class="data-wrap"><table class="data"><thead><tr>'+heads.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.join(''):'<tr><td colspan="20" class="empty-state">No records to show yet.</td></tr>')+'</tbody></table></div>';
  const actions = (...items) => '<div class="inline-actions">'+items.filter(Boolean).join('')+'</div>';
  const badge = v => { const x=String(v||'').toLowerCase();const c=['active','received','approved','completed','closed','issued'].includes(x)?'good':['submitted','ordered','partly_received','partly_approved','in_transit','received_with_differences'].includes(x)?'warn':['inactive','cancelled','rejected'].includes(x)?'bad':'';return '<span class="pill '+c+'">'+esc(x.replaceAll('_',' '))+'</span>'; };
  const toast = (message,error) => {const el=$('#toast');if(!el)return;el.textContent=message;el.classList.toggle('error',!!error);el.classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.add('hidden'),5000);};
  const errorMsg = e => e&&e.message?e.message:'The operation could not be completed.';
  const opts = (rows,label,blank) => (blank===false?'':'<option value="">'+esc(blank||'Choose…')+'</option>')+rows.map(r=>'<option value="'+esc(r.id!=null?r.id:r.key)+'">'+esc(label(r))+'</option>').join('');
  const tableError = e => '<div class="screen-error"><b>Could not load this section.</b><p>'+esc(errorMsg(e))+'</p>'+btn('Try again','refresh')+'</div>';

  function renderSetup(error) {
    $('#app').innerHTML='<main class="auth-screen"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">▣</div><div><b>Office Stock</b><div class="muted small">Local Windows desktop application</div></div></div><h1>Connect to Supabase</h1><p>Enter this project’s HTTPS URL and publishable key. Windows encrypts both values for this account.</p><div class="connection-note">Use a publishable key only. The app rejects service-role and secret keys.</div>'+(error?'<div class="alert alert-error" role="alert">'+esc(error)+'</div>':'')+'<form id="setup-form" class="stack" style="margin-top:1.2rem">'+field('url','Supabase project URL',{type:'url',required:true,placeholder:'https://your-project.supabase.co'})+field('publishableKey','Publishable key',{required:true,placeholder:'sb_publishable_…'})+'<button class="btn" type="submit">Validate and save</button></form><p class="small" style="margin-top:1rem">This checks the Auth endpoint. Apply the supplied database migrations before signing in.</p></section></main>';
  }
  function renderLogin(error) {
    $('#app').innerHTML='<main class="auth-screen"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">▣</div><div><b>Office Stock</b><div class="muted small">Secure sign in</div></div></div><h1>Welcome back</h1><p>Sign in with your Supabase Auth account.</p>'+(error?'<div class="alert alert-error" role="alert">'+esc(error)+'</div>':'')+'<form id="login-form" class="stack" style="margin-top:1.2rem">'+field('email','Email',{type:'email',required:true,placeholder:'name@company.com'})+field('password','Password',{type:'password',required:true})+'<button class="btn" type="submit">Sign in</button></form><div class="actions" style="margin-top:.7rem;justify-content:space-between">'+btn('Create account','show-signup','btn btn-ghost btn-sm')+btn('Forgot password?','show-reset','btn btn-ghost btn-sm')+'</div>'+btn('Change Supabase connection','edit-connection','btn btn-ghost btn-sm')+'</section></main>';
  }
  function renderSignup(error) {
    $('#app').innerHTML='<main class="auth-screen"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">▣</div><b>Office Stock</b></div><h1>Create an account</h1><p>New accounts remain inactive until an administrator assigns a branch and role. The first administrator must be activated with the one-time SQL bootstrap.</p>'+(error?'<div class="alert alert-error">'+esc(error)+'</div>':'')+'<form id="signup-form" class="stack" style="margin-top:1.2rem">'+field('name','Name',{required:true})+field('email','Email',{type:'email',required:true})+field('password','Password',{type:'password',required:true,help:'Use at least 12 characters.'})+'<button class="btn" type="submit">Create account</button></form>'+btn('Back to sign in','show-login','btn btn-ghost btn-sm')+'</section></main>';
  }
  function renderReset(error,success) {
    $('#app').innerHTML='<main class="auth-screen"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">▣</div><b>Office Stock</b></div><h1>Reset password</h1><p>Supabase sends a reset link to the account email.</p>'+(error?'<div class="alert alert-error">'+esc(error)+'</div>':'')+(success?'<div class="alert alert-success">'+esc(success)+'</div>':'')+'<form id="reset-form" class="stack">'+field('email','Email',{type:'email',required:true})+'<button class="btn" type="submit">Send reset link</button></form>'+btn('Back to sign in','show-login','btn btn-ghost btn-sm')+'</section></main>';
  }
  function renderBlocked(message) {
    $('#app').innerHTML='<main class="auth-screen"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">▣</div><b>Office Stock</b></div><h1>Access is not active</h1><p>'+esc(message||'Ask a Super Admin to assign a branch and role to your profile.')+'</p><div class="connection-note">New Supabase Auth users start inactive. The bootstrap SQL activates the first Super Admin without placing a privileged key in the app.</div><div class="actions" style="margin-top:1rem">'+btn('Check access again','retry-profile')+btn('Sign out','logout','btn btn-ghost')+'</div></section></main>';
  }

  async function boot() {
    try { cfg=await window.officeStock.settings.read(); if(!cfg)return renderSetup(); applySupabaseCsp(cfg.url); api=window.createOfficeStockClient(cfg); await api.restore(); if(pendingAuthCallback){const c=pendingAuthCallback;pendingAuthCallback=null;return handleAuthCallback(c);} if(api.session&&api.session.user)return hydrate(); renderLogin(); }
    catch(e){if(api&&e.status)return renderLogin('Your saved session expired. Sign in again.');renderSetup(errorMsg(e));}
  }
  async function handleAuthCallback(callback) {
    if(!api){pendingAuthCallback=callback;return;}
    try{
      if(!callback||!callback.access_token||!callback.refresh_token||!['recovery','signup','magiclink','invite','email_change'].includes(callback.type))return renderLogin('This authentication link cannot be opened. Request a new link and try again.');
      await api.storeSession(callback);
      api.session.user=await api.request('/auth/v1/user',{},true);
      await window.officeStock.secure.saveSession(api.session);
      await hydrate();
      if(callback.recovery)passwordDialog();
    }catch(error){renderLogin('The password reset link could not be opened. Request a new link and try again.');}
  }
  async function hydrate() {
    if(!api||!api.session||!api.session.user)return renderLogin();
    try {
      profile=await api.one('profiles',{id:'eq.'+api.session.user.id});
      if(!profile)return renderBlocked('No application profile exists. Check that the Supabase SQL migration and Auth trigger were installed.');
      if(!profile.active||!profile.role_key||profile.role_key==='pending')return renderBlocked();
      role=profile.role_key==='super_admin'?{key:'super_admin',name:'Super Admin',side:'main',permissions:PERMS.map(x=>x[0])}:await api.one('roles',{key:'eq.'+profile.role_key});
      if(!role)return renderBlocked('The assigned role was removed. Ask a Super Admin to assign a valid role.');
      branch=profile.branch_id?await api.one('branches',{id:'eq.'+profile.branch_id}):null;
      settings=await api.one('app_settings',{id:'eq.1'});
      if(!settings)throw new Error('The Supabase schema is not installed. Apply the supplied SQL migrations in filename order.');
      screen='dashboard';renderShell();
    } catch(e) {
      if(e.status===401){await api.signOut();return renderLogin('Your session expired. Sign in again.');}
      $('#app').innerHTML='<main class="auth-screen"><section class="auth-card"><h1>Cannot open Office Stock</h1><p>'+esc(errorMsg(e))+'</p><p class="small">Check the database migration, internet connection, and the account’s RLS permissions.</p>'+btn('Retry','retry-profile')+btn('Sign out','logout','btn btn-ghost')+'</section></main>';
    }
  }
  function renderShell() {
    const links=NAV.filter(allowed).map(n=>'<a href="#" data-screen="'+n.id+'" class="'+(screen===n.id?'active':'')+'"><span class="icon">'+n.icon+'</span>'+esc(n.label)+'</a>').join('');
    $('#app').innerHTML='<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">▣</div><span class="brand-name">'+esc(settings.company_name||'Office Stock')+'</span></div><nav class="nav" aria-label="Main">'+links+'</nav><div class="sidebar-foot">'+btn('Lock screen','logout','btn btn-ghost btn-sm')+'</div></aside><div class="main-col"><header class="topbar"><div><b>'+esc(branch&&branch.name||'Office Stock')+'</b><div class="muted small">Connected to shared Supabase data</div></div><div class="topbar-right"><div class="who"><b>'+esc(profile.name||profile.email)+'</b><span>'+esc(role.name||profile.role_key)+'</span></div>'+btn('Change email','email-change','btn btn-ghost btn-sm')+btn('Password','password-change','btn btn-ghost btn-sm')+btn('Sign out','logout','btn btn-ghost btn-sm')+'</div></header><div id="connection-banner"></div><main class="content" id="content"><div class="empty-state">Loading…</div></main></div></div>';
    loadScreen();
  }
  function invalidate() { Object.keys(cache).forEach(k=>delete cache[k]); }
  async function records(name,params) {
    const query=Object.assign({limit:'500'},params||{}),size=Math.max(1,Math.min(Number(query.limit)||500,500)),all=[];
    let offset=0;
    while(offset<100000){
      const rows=await api.list(name,Object.assign({},query,{limit:String(size),offset:String(offset)}));
      all.push(...(rows||[]));
      if(!rows||rows.length<size)break;
      offset+=size;
    }
    return all;
  }
  async function loadScreen() {
    if(!$('#content'))return;
    $('#content').innerHTML='<div class="empty-state">Loading shared data…</div>';
    try {
      const map={dashboard:screenDashboard,items:screenItems,suppliers:screenSuppliers,purchases:screenPurchases,issues:screenIssues,stock:screenStock,requests:screenRequests,dispatches:screenDispatches,petty_cash:screenCash,reports:screenReports,branches:screenBranches,users:screenUsers,roles:screenRoles,audit:screenAudit,settings:screenSettings};
      await (map[screen]||screenDashboard)();
      const banner=$('#connection-banner');if(banner)banner.innerHTML='';
    } catch(e) {
      $('#content').innerHTML=tableError(e);
      const banner=$('#connection-banner');if(banner&&(!navigator.onLine||e.status===0))banner.innerHTML='<div class="alert alert-warning offline-banner">No internet connection. Office Stock uses the shared database and cannot save changes offline.</div>';
    }
  }
  function setScreen(id) { if(!NAV.some(n=>n.id===id&&allowed(n)))return;screen=id;renderShell(); }
  function sumBalances(ledger) {
    const m=new Map();ledger.forEach(x=>{const k=x.item_id+':'+(x.branch_id==null?'transit':x.branch_id);m.set(k,(m.get(k)||0)+Number(x.quantity_change));});return m;
  }
  async function screenDashboard() {
    const tasks=[
      has('items.view')||has('requests.create')?records('items',{order:'name.asc'}):Promise.resolve([]),
      has('stock.view')?records('stock_ledger',{order:'created_at.desc'}):Promise.resolve([]),
      has('requests.review')||has('requests.create')?records('requests',{order:'created_at.desc'}):Promise.resolve([]),
      has('dispatches.manage')||has('dispatches.receive')?records('dispatches',{order:'dispatch_date.desc'}):Promise.resolve([]),
      has('purchases.view')?records('purchases',{order:'purchase_date.desc'}):Promise.resolve([])
    ];
    const [items,ledger,requests,dispatches,purchases]=await Promise.all(tasks), balances=sumBalances(ledger);
    const stock=items.filter(i=>i.active).map(i=>({item:i,balance:balances.get(i.id+':'+profile.branch_id)||0}));
    const low=stock.filter(x=>x.balance<=Number(x.item.min_stock));
    const tiles=[];
    if(has('items.view'))tiles.push(['Active items',items.filter(i=>i.active).length,'']);
    if(has('stock.view'))tiles.push(['Low stock items',low.length,low.length?'warn':'']);
    if(has('purchases.view'))tiles.push(['Open purchases',purchases.filter(p=>['ordered','partly_received'].includes(p.status)).length,'']);
    if(has('requests.review')||has('requests.create'))tiles.push(['Pending requests',requests.filter(r=>r.status==='submitted').length,'']);
    if(has('dispatches.manage')||has('dispatches.receive'))tiles.push(['In transit',dispatches.filter(d=>d.status==='in_transit').length,'']);
    const tileHtml=tiles.map(t=>'<div class="tile"><div class="label">'+esc(t[0])+'</div><div class="value '+t[2]+'">'+t[1]+'</div><div class="note">Shared Supabase data</div></div>').join('');
    const rows=low.slice(0,8).map(x=>'<tr><td class="mono">'+esc(x.item.code)+'</td><td>'+esc(x.item.name)+'</td><td>'+esc(x.item.unit)+'</td><td class="right">'+x.balance+'</td><td class="right">'+x.item.min_stock+'</td></tr>');
    $('#content').innerHTML=page('Welcome, '+(profile.name||profile.email),'Current activity for your branch and role.','<div class="grid grid-4">'+tileHtml+'</div><div class="grid grid-2" style="margin-top:1rem">'+card('Stock needing attention',has('stock.view')?table(['Code','Item','Unit','On hand','Minimum'],rows):'<p class="muted">Stock access is not enabled.</p>')+card('Recent activity','<p class="muted">Purchases: <b>'+purchases.length+'</b></p><p class="muted">Requests: <b>'+requests.length+'</b></p><p class="muted">Dispatches: <b>'+dispatches.length+'</b></p>')+'</div>');
  }
  async function screenItems() {
    const [items,cats,ledger]=await Promise.all([records('items',{order:'name.asc'}),records('categories',{order:'name.asc'}),records('stock_ledger',{branch_id:'eq.'+profile.branch_id})]), cm=new Map(cats.map(c=>[c.id,c.name])), balances=sumBalances(ledger);
    const rows=items.map(i=>{const balance=balances.get(i.id+':'+profile.branch_id)||0;return '<tr><td class="mono">'+esc(i.code)+'</td><td><b>'+esc(i.name)+'</b></td><td>'+esc(cm.get(i.category_id)||'')+'</td><td>'+esc(i.unit)+'</td><td>'+balance+(i.active&&balance<=Number(i.min_stock)?' <span class="pill warn">Low</span>':'')+'</td><td>'+i.min_stock+'</td><td>'+badge(i.active?'active':'inactive')+'</td><td>'+ (has('items.manage')?actions(btn('Edit','item-edit','btn btn-ghost btn-sm',i.id),btn(i.active?'Deactivate':'Reactivate','item-toggle','btn btn-ghost btn-sm',i.id),btn('Delete','item-delete','btn btn-ghost btn-sm',i.id)):'')+'</td></tr>';});
    const catRows=cats.map(c=>'<tr><td><b>'+esc(c.name)+'</b></td><td>'+(has('items.manage')?actions(btn('Rename','category-edit','btn btn-ghost btn-sm',c.id),btn('Delete','category-delete','btn btn-ghost btn-sm',c.id)):'')+'</td></tr>');
    const actionsHtml=has('items.manage')?btn('Add item','item-new','btn')+btn('Add category','category-new'):'';
    $('#content').innerHTML=page('Items','Catalog records and minimum stock levels.',card('Item catalogue',table(['Code','Item','Category','Unit','On hand','Minimum','State',''],rows))+'<div style="margin-top:1rem">'+card('Categories',table(['Category',''],catRows))+'</div>',actionsHtml);
  }
  async function screenSuppliers() {
    const rows=await records('suppliers',{order:'name.asc'});
    $('#content').innerHTML=page('Suppliers','Supplier details used on purchase records.',card('Supplier directory',table(['Supplier','Contact','Phone','State',''],rows.map(s=>'<tr><td><b>'+esc(s.name)+'</b></td><td>'+esc(s.contact)+'</td><td>'+esc(s.phone)+'</td><td>'+badge(s.active?'active':'inactive')+'</td><td>'+ (has('suppliers.manage')?actions(btn('Edit','supplier-edit','btn btn-ghost btn-sm',s.id),btn(s.active?'Deactivate':'Reactivate','supplier-toggle','btn btn-ghost btn-sm',s.id),btn('Delete','supplier-delete','btn btn-ghost btn-sm',s.id)):'')+'</td></tr>'))),has('suppliers.manage')?btn('Add supplier','supplier-new','btn'):'');
  }
  async function screenPurchases() {
    const [rows,suppliers,items]=await Promise.all([records('purchases',{order:'purchase_date.desc'}),records('suppliers',{order:'name.asc'}),records('items',{order:'name.asc'})]);
    const sm=new Map(suppliers.map(s=>[s.id,s.name])),im=new Map(items.map(i=>[i.id,i.name]));
    const sets=await Promise.all(rows.map(p=>records('purchase_lines',{purchase_id:'eq.'+p.id,limit:'100'})));
    const body=table(['Number','Date','Supplier','Items','Status',''],rows.map((p,n)=>'<tr><td class="mono">'+esc(p.number)+'</td><td>'+date(p.purchase_date)+'</td><td>'+esc(sm.get(p.supplier_id)||'')+'</td><td>'+sets[n].map(l=>esc(im.get(l.item_id)||'')+' × '+l.quantity_received+'/'+l.quantity_ordered).join('<br>')+'</td><td>'+badge(p.status)+'</td><td>'+actions(p.status==='ordered'&&has('purchases.manage')?btn('Edit','purchase-edit','btn btn-ghost btn-sm',p.id):'', ['ordered','partly_received'].includes(p.status)&&has('purchases.receive')?btn('Receive','purchase-receive','btn btn-ghost btn-sm',p.id):'',p.status==='ordered'&&has('purchases.manage')?btn('Cancel','purchase-cancel','btn btn-ghost btn-sm',p.id):'')+'</td></tr>'));
    $('#content').innerHTML=page('Purchases','Record supplier orders and receive deliveries into stock.',card('Purchase register',body),has('purchases.manage')?btn('New purchase','purchase-new','btn'):'');
  }
  async function screenIssues() {
    const [issues,items]=await Promise.all([records('office_issues',{order:'issue_date.desc'}),records('items',{order:'name.asc'})]), im=new Map(items.map(i=>[i.id,i.name]));
    const sets=await Promise.all(issues.map(x=>records('office_issue_lines',{issue_id:'eq.'+x.id,limit:'100'})));
    $('#content').innerHTML=page('Office issues','Record items handed out and reverse mistakes through the stock ledger.',card('Issue register',table(['Number','Date','Recipient','Items','Purpose','State',''],issues.map((i,n)=>'<tr><td class="mono">'+esc(i.number)+'</td><td>'+date(i.issue_date)+'</td><td>'+esc(i.recipient)+'</td><td>'+sets[n].map(l=>esc(im.get(l.item_id)||'')+' × '+l.quantity).join('<br>')+'</td><td>'+esc(i.purpose)+'</td><td>'+badge(i.status)+'</td><td>'+ (i.status==='issued'&&has('issues.manage')?btn('Cancel issue','issue-cancel','btn btn-ghost btn-sm',i.id):'')+'</td></tr>'))),has('issues.manage')?btn('Issue items','issue-new','btn'):'' );
  }
  async function screenStock() {
    const [items,branches,ledger]=await Promise.all([records('items',{order:'name.asc'}),records('branches',{order:'type.asc,name.asc'}),records('stock_ledger',{order:'created_at.desc'})]), m=sumBalances(ledger);
    const rows=items.map(i=>'<tr><td class="mono">'+esc(i.code)+'</td><td>'+esc(i.name)+'</td><td>'+esc(i.unit)+'</td>'+branches.map(b=>'<td class="right">'+(m.get(i.id+':'+b.id)||0)+'</td>').join('')+'<td class="right">'+i.min_stock+'</td></tr>');
    $('#content').innerHTML=page('Stock & movements','Branch balances calculated from the append-only ledger.',card('Current balances',table(['Code','Item','Unit'].concat(branches.map(b=>b.name),['Minimum']),rows)+'<p class="muted small">Final stock changes are checked and recorded atomically in Supabase.</p>'),has('stock.adjust')?btn('Correct stock','stock-adjust','btn'):'');
  }
  async function screenRequests() {
    const [rows,items,branches]=await Promise.all([records('requests',{order:'created_at.desc'}),records('items',{order:'name.asc'}),records('branches',{order:'name.asc'})]), bm=new Map(branches.map(b=>[b.id,b.name])), im=new Map(items.map(i=>[i.id,i.name]));
    const sets=await Promise.all(rows.map(x=>records('request_lines',{request_id:'eq.'+x.id,limit:'100'})));
    const body=table(['Request','Branch','Created','Items','Status',''],rows.map((r,n)=>'<tr><td class="mono">'+esc(r.number)+'</td><td>'+esc(bm.get(r.branch_id)||'')+'</td><td>'+time(r.created_at)+'</td><td>'+sets[n].map(l=>esc(im.get(l.item_id)||'')+' × '+l.quantity_requested+(l.quantity_approved?' (approved '+l.quantity_approved+')':'')).join('<br>')+'</td><td>'+badge(r.status)+'</td><td>'+actions(r.status==='submitted'&&has('requests.review')?btn('Review','request-review','btn btn-ghost btn-sm',r.id):'',r.status==='submitted'&&r.requested_by===profile.id?btn('Withdraw','request-cancel','btn btn-ghost btn-sm',r.id):'')+'</td></tr>'));
    $('#content').innerHTML=page('Branch requests','Review requested quantities before stock is dispatched.',card('Request register',body),has('requests.create')?btn('New request','request-new','btn'):'');
  }
  async function screenDispatches() {
    const [rows,branches,items]=await Promise.all([records('dispatches',{order:'dispatch_date.desc'}),records('branches',{order:'name.asc'}),records('items',{order:'name.asc'})]), bm=new Map(branches.map(b=>[b.id,b.name])), im=new Map(items.map(i=>[i.id,i.name]));
    const sets=await Promise.all(rows.map(x=>records('dispatch_lines',{dispatch_id:'eq.'+x.id,limit:'100'})));
    const body=table(['Reference','Date','Destination','Items','Status',''],rows.map((d,n)=>'<tr><td class="mono">'+esc(d.reference)+'</td><td>'+date(d.dispatch_date)+'</td><td>'+esc(bm.get(d.destination_id)||'')+'</td><td>'+sets[n].map(l=>esc(im.get(l.item_id)||'')+' × '+l.quantity_sent+(d.status!=='in_transit'?' (received '+l.quantity_received+')':'')).join('<br>')+'</td><td>'+badge(d.status)+'</td><td>'+actions(d.status==='in_transit'&&has('dispatches.receive')?btn('Confirm receipt','dispatch-receive','btn btn-ghost btn-sm',d.id):'', ['received','received_with_differences'].includes(d.status)&&has('dispatches.manage')?btn('Close','dispatch-close','btn btn-ghost btn-sm',d.id):'')+'</td></tr>'));
    $('#content').innerHTML=page('Dispatches','Send stock to branches and confirm delivery.',card('Dispatch register',body),has('dispatches.manage')?btn('New dispatch','dispatch-new','btn'):'');
  }
  async function screenCash() {
    const [reqs,entries,branches,settingsRows]=await Promise.all([records('petty_cash_requests',{order:'created_at.desc'}),records('petty_cash_entries',{order:'entry_date.desc'}),records('branches',{order:'name.asc'}),records('app_settings',{id:'eq.1'})]);
    settings=settingsRows[0]||settings;const bm=new Map(branches.map(b=>[b.id,b.name])), balances=new Map();
    entries.forEach(e=>balances.set(e.branch_id,(balances.get(e.branch_id)||0)+Number(e.amount)));
    const visibleCashBranches=has('petty_cash.view')?branches:branches.filter(b=>Number(b.id)===Number(profile.branch_id));
    const rb=table(['Branch','Balance','Level'],visibleCashBranches.map(b=>'<tr><td>'+esc(b.name)+'</td><td class="right">'+cash(balances.get(b.id)||0)+'</td><td>'+((balances.get(b.id)||0)<=Number(settings.petty_cash_low_level)?'<span class="pill warn">Low</span>':'<span class="pill good">OK</span>')+'</td></tr>'));
    const rr=table(['Request','Branch','Requested','Approved','Status',''],reqs.map(r=>'<tr><td class="mono">'+esc(r.number)+'</td><td>'+esc(bm.get(r.branch_id)||'')+'</td><td class="right">'+cash(r.amount_requested)+'</td><td class="right">'+cash(r.amount_approved)+'</td><td>'+badge(r.status)+'</td><td>'+actions(r.status==='submitted'&&has('petty_cash.approve')?btn('Review','cash-review','btn btn-ghost btn-sm',r.id):'',r.status==='submitted'&&r.requested_by===profile.id?btn('Withdraw','cash-cancel','btn btn-ghost btn-sm',r.id):'')+'</td></tr>'));
    const er=table(['Date','Branch','Description','Type','Amount',''],entries.map(e=>'<tr><td>'+date(e.entry_date)+'</td><td>'+esc(bm.get(e.branch_id)||'')+'</td><td>'+esc(e.description)+'</td><td>'+esc(e.type.replaceAll('_',' '))+'</td><td class="right">'+cash(e.amount)+'</td><td>'+(e.type==='expense'?btn('Reverse','cash-reverse','btn btn-ghost btn-sm',e.id):'')+'</td></tr>'));
    const levelCard=has('petty_cash.configure')?card('Low balance warning','<form id="low-level-form" class="form-grid">'+field('petty_cash_low_level','Warning level (Rs.)',{type:'number',step:'0.01',min:0,value:settings.petty_cash_low_level,required:true})+'<div><button class="btn" type="submit">Save threshold</button></div></form>'):'';
    $('#content').innerHTML=page('Petty cash','Requests, branch balances, and the cash book.', '<div class="grid grid-2">'+card('Branch balances',rb)+card('Funding requests',rr)+'</div><div style="margin-top:1rem">'+card('Cash book',er)+'</div>'+(levelCard?'<div style="margin-top:1rem">'+levelCard+'</div>':''),(has('petty_cash.request')?btn('Request funds','cash-request','btn')+btn('Record spending','cash-expense'):''));
  }
  async function screenBranches() {
    const rows=await records('branches',{order:'type.asc,name.asc'});
    $('#content').innerHTML=page('Branches','Manage offices and branch locations.',card('Branch directory',table(['Name','Code','Type','Phone','State',''],rows.map(b=>'<tr><td><b>'+esc(b.name)+'</b></td><td class="mono">'+esc(b.code)+'</td><td>'+esc(b.type==='main'?'Main office':'Branch')+'</td><td>'+esc(b.phone)+'</td><td>'+badge(b.active?'active':'inactive')+'</td><td>'+actions(btn('Edit','branch-edit','btn btn-ghost btn-sm',b.id),btn('Delete','branch-delete','btn btn-ghost btn-sm',b.id))+'</td></tr>'))),btn('Add branch','branch-new','btn'));
  }
  async function screenUsers() {
    const [users,branches,roles]=await Promise.all([records('profiles',{order:'name.asc'}),records('branches',{order:'name.asc'}),records('roles',{order:'name.asc'})]);
    const bm=new Map(branches.map(b=>[b.id,b.name])),rm=new Map(roles.map(r=>[r.key,r.name]));rm.set('super_admin','Super Admin');
    $('#content').innerHTML=page('Users','Supabase Auth accounts and their application role.',card('User access',table(['User','Role','Branch','State',''],users.map(u=>'<tr><td><b>'+esc(u.name||'')+'</b><br><span class="muted small">'+esc(u.email)+'</span></td><td>'+esc(rm.get(u.role_key)||u.role_key)+'</td><td>'+esc(bm.get(u.branch_id)||'Unassigned')+'</td><td>'+badge(u.active?'active':'inactive')+'</td><td>'+btn('Edit access','user-edit','btn btn-ghost btn-sm',u.id)+'</td></tr>'))),btn('Create user','user-new','btn'));
  }
  async function screenRoles() {
    const rows=await records('roles',{order:'name.asc'});
    $('#content').innerHTML=page('Roles','Configure feature permissions for each staff role.',card('Role templates',table(['Role','Side','Description','Permissions',''],rows.map(r=>'<tr><td><b>'+esc(r.name)+'</b><br><span class="muted small mono">'+esc(r.key)+'</span></td><td>'+esc(r.side)+'</td><td>'+esc(r.description)+'</td><td>'+((r.permissions||[]).length)+'</td><td>'+actions(btn('Edit','role-edit','btn btn-ghost btn-sm',r.key),btn('Delete','role-delete','btn btn-ghost btn-sm',r.key))+'</td></tr>'))),btn('Add role','role-new','btn'));
  }
  async function screenAudit() {
    const rows=await records('audit_logs',{order:'created_at.desc'});
    const ids=[...new Set(rows.map(x=>x.user_id).filter(Boolean))],users=ids.length?await records('profiles',{select:'id,name,email',id:'in.('+ids.join(',')+')'}):[],um=new Map(users.map(u=>[u.id,u.name||u.email]));
    $('#content').innerHTML=page('Audit log','Append-only record of important changes.',card('Recent events',table(['When','User','Action','Record','Details'],rows.map(r=>'<tr><td>'+time(r.created_at)+'</td><td>'+esc(um.get(r.user_id)||'System')+'</td><td>'+esc(r.action)+'</td><td>'+esc(r.record_type)+' '+esc(r.record_id)+'</td><td><details><summary>View</summary><pre>'+esc(JSON.stringify(r.new_value||r.old_value||{},null,2))+'</pre></details></td></tr>'))),btn('Clear date range','audit-clear','btn btn-secondary'));
  }
  async function auditClearDialog() {
    openForm('Clear audit entries','<p class="muted">Entries in this date range will be deleted. When audit logging is enabled, the cleanup is recorded as a new event.</p><div class="form-grid">'+field('from','Start date',{type:'date',required:true})+field('to','End date',{type:'date',required:true})+'</div>',async fd=>{
      if(fd.get('from')>fd.get('to'))throw new Error('The start date must be on or before the end date.');
      if(!confirm('Permanently clear audit entries for the selected dates?'))throw new Error('Cleanup cancelled.');
      await api.rpc('clear_audit_logs',{p_from:fd.get('from'),p_to:fd.get('to')});
    },'Clear entries');
  }
  async function screenReports() {
    const [branches,suppliers,items,categories]=await Promise.all([
      records('branches',{active:'eq.true',order:'type.asc,name.asc'}),
      reportState.type==='purchases'?records('suppliers',{order:'name.asc'}):Promise.resolve([]),
      (reportState.type==='balances'||reportState.type==='purchases'||reportState.type==='usage'||reportState.type==='dispatches')?records('items',{order:'name.asc'}):Promise.resolve([]),
      reportState.type==='balances'?records('categories',{order:'name.asc'}):Promise.resolve([])
    ]);
    const reportTypes=[{value:'balances',label:'Current stock'}];
    if(has('reports.view'))reportTypes.push({value:'purchases',label:'Purchases'});
    if(has('reports.view'))reportTypes.push({value:'usage',label:'Usage'});
    if(settings&&settings.branch_module_enabled&&has('reports.view'))reportTypes.push({value:'dispatches',label:'Dispatches'});
    if(!reportTypes.some(x=>x.value===reportState.type))reportState.type='balances';
    const inDateRange=value=>(!reportState.from||value>=reportState.from)&&(!reportState.to||value<=reportState.to);
    const selectedBranch=reportState.branch?Number(reportState.branch):null;
    const columns=[],resultRows=[];
    if(reportState.type==='balances'){
      const ledger=await records('stock_ledger',{order:'created_at.desc'});
      const sums=sumBalances(ledger),categoryMap=new Map(categories.map(c=>[c.id,c.name]));
      const visibleBranches=branches.filter(b=>!selectedBranch||b.id===selectedBranch);
      items.filter(i=>i.active||visibleBranches.some(b=>(sums.get(i.id+':'+b.id)||0)!==0))
        .forEach(i=>visibleBranches.forEach(b=>{
          const balance=sums.get(i.id+':'+b.id)||0;
          if(reportState.low&&(!i.active||balance>Number(i.min_stock)))return;
          resultRows.push({code:i.code,item:i.name,category:categoryMap.get(i.category_id)||'',branch:b.name,quantity:balance,unit:i.unit,minimum:i.min_stock,status:!i.active?'Inactive':balance<=0?'Out of stock':balance<=Number(i.min_stock)?'Low stock':'In stock',cost:i.last_unit_cost==null?'':Number(i.last_unit_cost),value:i.last_unit_cost==null?'':Math.max(balance,0)*Number(i.last_unit_cost)});
        }));
      columns.push(['code','Code'],['item','Item'],['category','Category'],['branch','Branch'],['quantity','In stock'],['unit','Unit'],['minimum','Minimum'],['status','Status'],['cost','Last cost'],['value','Stock value']);
    } else if(reportState.type==='purchases'){
      const [purchases,purchaseLines]=await Promise.all([records('purchases',{order:'purchase_date.desc'}),records('purchase_lines')]);
      const supplierMap=new Map(suppliers.map(s=>[s.id,s.name])),itemMap=new Map(items.map(i=>[i.id,i]));
      const group=new Map();
      purchases.filter(p=>p.status!=='cancelled'&&inDateRange(p.purchase_date)&&(!selectedBranch||p.branch_id===selectedBranch)&&(!reportState.supplier||p.supplier_id===Number(reportState.supplier)))
        .forEach(p=>purchaseLines.filter(l=>l.purchase_id===p.id).forEach(l=>{
          const item=itemMap.get(l.item_id)||{},byItem=reportState.by==='item',key=byItem?'i:'+l.item_id:'s:'+p.supplier_id;
          const g=group.get(key)||{supplier:supplierMap.get(p.supplier_id)||'',code:item.code||'',item:item.name||'',unit:item.unit||'',purchases:new Set(),quantity_ordered:0,quantity_received:0,ordered_value:0,received_value:0};
          g.purchases.add(p.id);g.quantity_ordered+=Number(l.quantity_ordered);g.quantity_received+=Number(l.quantity_received);g.ordered_value+=Number(l.quantity_ordered)*Number(l.unit_cost);g.received_value+=Number(l.quantity_received)*Number(l.unit_cost);group.set(key,g);
        }));
      for(const g of group.values())resultRows.push({...(reportState.by==='item'?{code:g.code,item:g.item,unit:g.unit}:{supplier:g.supplier}),purchases:g.purchases.size,quantity_ordered:g.quantity_ordered,quantity_received:g.quantity_received,ordered_value:g.ordered_value,received_value:g.received_value,outstanding_value:g.ordered_value-g.received_value});
      resultRows.sort((a,b)=>b.ordered_value-a.ordered_value);
      if(reportState.by==='item')columns.push(['code','Code'],['item','Item'],['unit','Unit']);else columns.push(['supplier','Supplier']);
      columns.push(['purchases','Purchases'],['quantity_ordered','Qty ordered'],['quantity_received','Qty received'],['ordered_value','Ordered value'],['received_value','Received value'],['outstanding_value','Still to receive']);
    } else if(reportState.type==='usage'){
      const [issues,issueLines]=await Promise.all([records('office_issues',{order:'issue_date.desc'}),records('office_issue_lines')]);
      const itemMap=new Map(items.map(i=>[i.id,i])),group=new Map();
      issues.filter(i=>i.status!=='cancelled'&&inDateRange(i.issue_date)&&(!selectedBranch||i.branch_id===selectedBranch)&&(!reportState.department||String(i.department||'').toLowerCase()===reportState.department.trim().toLowerCase()))
        .forEach(i=>issueLines.filter(l=>l.issue_id===i.id).forEach(l=>{
          const item=itemMap.get(l.item_id)||{},dept=String(i.department||'').trim()||'No department',byDept=reportState.by==='department',key=byDept?'d:'+dept:'i:'+l.item_id;
          const g=group.get(key)||{department:dept,code:item.code||'',item:item.name||'',unit:item.unit||'',issues:new Set(),quantity:0};g.issues.add(i.id);g.quantity+=Number(l.quantity);group.set(key,g);
        }));
      for(const g of group.values())resultRows.push(reportState.by==='department'?{department:g.department,issues:g.issues.size,quantity:g.quantity}:{code:g.code,item:g.item,unit:g.unit,issues:g.issues.size,quantity:g.quantity});
      resultRows.sort((a,b)=>b.quantity-a.quantity);
      if(reportState.by==='department')columns.push(['department','Department']);else columns.push(['code','Code'],['item','Item'],['unit','Unit']);
      columns.push(['issues','Times issued'],['quantity','Quantity issued']);
    } else {
      const [dispatches,dispatchLines]=await Promise.all([records('dispatches',{order:'dispatch_date.desc'}),records('dispatch_lines')]);
      const branchMap=new Map(branches.map(b=>[b.id,b.name])),itemMap=new Map(items.map(i=>[i.id,i])),group=new Map();
      dispatches.filter(d=>inDateRange(d.dispatch_date)&&(!selectedBranch||d.destination_id===selectedBranch))
        .forEach(d=>dispatchLines.filter(l=>l.dispatch_id===d.id).forEach(l=>{
          const item=itemMap.get(l.item_id)||{},key=d.destination_id+':'+l.item_id,g=group.get(key)||{branch:branchMap.get(d.destination_id)||'',code:item.code||'',item:item.name||'',unit:item.unit||'',dispatches:new Set(),sent:0,received:0,damaged:0,short:0};
          g.dispatches.add(d.id);g.sent+=Number(l.quantity_sent);g.received+=Number(l.quantity_received);g.damaged+=Number(l.quantity_damaged);g.short+=Number(l.quantity_short);group.set(key,g);
        }));
      for(const g of group.values())resultRows.push({branch:g.branch,code:g.code,item:g.item,unit:g.unit,dispatches:g.dispatches.size,sent:g.sent,received:g.received,damaged:g.damaged,short:g.short});
      resultRows.sort((a,b)=>a.branch.localeCompare(b.branch)||a.item.localeCompare(b.item));
      columns.push(['branch','Branch'],['code','Code'],['item','Item'],['unit','Unit'],['dispatches','Dispatches'],['sent','Sent'],['received','Received'],['damaged','Damaged'],['short','Missing']);
    }
    window.currentReport={rows:resultRows,columns,type:reportState.type};
    const branchOptions=[{value:'',label:role&&role.side==='branch'?'My branch':'All branches'},...branches.map(b=>({value:b.id,label:b.name}))];
    const filter='<form id="report-filter" class="form-grid report-filters">'+field('type','Report',{type:'select',value:reportState.type,options:reportTypes})+field('branch','Branch',{type:'select',value:reportState.branch,options:branchOptions})+field('from','From',{type:'date',value:reportState.from})+field('to','To',{type:'date',value:reportState.to})+field('by','Group by',{type:'select',value:reportState.by,options:reportState.type==='purchases'?[{value:'supplier',label:'Supplier'},{value:'item',label:'Item'}]:reportState.type==='usage'?[{value:'item',label:'Item'},{value:'department',label:'Department'}]:[{value:'item',label:'Item'}]})+(reportState.type==='purchases'?field('supplier','Supplier',{type:'select',value:reportState.supplier,options:[{value:'',label:'All suppliers'},...suppliers.map(s=>({value:s.id,label:s.name}))]}):'')+(reportState.type==='usage'?field('department','Department',{value:reportState.department,placeholder:'Any department'}):'')+(reportState.type==='balances'?field('low','Low stock only',{type:'select',value:String(reportState.low),options:[{value:'false',label:'No'},{value:'true',label:'Yes'}]}):'')+'<div><button class="btn" type="submit">Run report</button></div></form>';
    const header=columns.map(c=>c[1]),tableRows=resultRows.map(row=>'<tr>'+columns.map(([key])=>'<td'+(typeof row[key]==='number'?' class="right"':'')+'>'+esc(typeof row[key]==='number'&&key.includes('value')?cash(row[key]):row[key])+'</td>').join('')+'</tr>');
    const summary='<div class="grid grid-3"><div class="tile"><div class="label">Report rows</div><div class="value">'+resultRows.length+'</div></div><div class="tile"><div class="label">Report</div><div class="value">'+esc(reportTypes.find(x=>x.value===reportState.type).label)+'</div></div><div class="tile"><div class="label">Shared source</div><div class="value">Supabase</div></div></div>';
    $('#content').innerHTML=page('Reports','Current stock, purchases, usage, and branch dispatches.',card('Filters',filter)+'<div style="margin-top:1rem">'+summary+'</div><div style="margin-top:1rem">'+card('Report results',table(header,tableRows))+'</div>',btn('Export CSV','report-export','btn'));
  }
  async function screenSettings() {
    settings=await api.one('app_settings',{id:'eq.1'});
    $('#content').innerHTML=page('Settings','Company information and connection status.','<div class="grid grid-2">'+card('Company settings','<form id="settings-form" class="form-grid">'+field('company_name','Company name',{value:settings.company_name,required:true})+field('branch_module_enabled','Branch module',{type:'select',value:String(settings.branch_module_enabled),options:[{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}]})+field('audit_logging_enabled','Audit logging',{type:'select',value:String(settings.audit_logging_enabled),options:[{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}]})+'<div class="span-2"><button class="btn" type="submit">Save settings</button></div></form>')+card('Petty cash threshold','<form id="low-level-form" class="form-grid">'+field('petty_cash_low_level','Low balance warning (Rs.)',{type:'number',step:'0.01',min:0,value:settings.petty_cash_low_level,required:true})+'<div><button class="btn" type="submit">Save threshold</button></div></form>')+card('Stock movement retention','<p class="small">Keep detailed stock movements for 30 days. Older movements are replaced with balance rows.</p>'+btn('Run retention cleanup','retention-run','btn btn-secondary'))+card('Supabase project','<p class="small muted">'+esc(cfg.url)+'</p><p class="small">The publishable key and session are encrypted with Windows secure storage.</p>'+btn('Change connection','edit-connection','btn btn-secondary'))+'</div>');
  }


  const dialog=$('#dialog');
  let modalItems=[];
  function openForm(title,body,onSave,saveLabel) {
    dialog.innerHTML='<form id="modal-form"><div class="modal-head"><h2>'+esc(title)+'</h2><button class="btn btn-ghost btn-sm" type="button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body">'+body+'</div><div class="modal-foot"><button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button><button class="btn" type="submit">'+esc(saveLabel||'Save')+'</button></div></form>';
    dialog.showModal();
    $('#modal-form').addEventListener('submit',async ev=>{
      ev.preventDefault();if(dialog.dataset.saving==='1')return;dialog.dataset.saving='1';
      const submit=$('button[type="submit"]',dialog);submit.disabled=true;submit.textContent='Saving…';
      try { await onSave(new FormData(ev.currentTarget),ev.currentTarget);dialog.close();invalidate();await loadScreen();toast('Saved successfully.'); }
      catch(error){toast(errorMsg(error),true);submit.disabled=false;submit.textContent=saveLabel||'Save';}
      finally{dialog.dataset.saving='0';}
    });
  }
  function lineRow(items,withCost,value={}) {
    const itemOptions='<option value="">Choose…</option>'+items.map(i=>'<option value="'+esc(i.id)+'" '+(Number(value.item_id)===Number(i.id)?'selected':'')+'>'+esc(i.code+' — '+i.name)+'</option>').join('');
    return '<div class="line-editor" data-line-row><div class="field"><label>Item *</label><select name="item_id" required>'+itemOptions+'</select></div><div class="field"><label>Quantity *</label><input name="quantity" type="number" min="1" step="1" value="'+esc(value.quantity||'')+'" required></div>'+(withCost?'<div class="field"><label>Unit cost *</label><input name="unit_cost" type="number" min="0" step="0.01" value="'+esc(value.unit_cost||'')+'" required></div>':'')+'<button class="btn btn-ghost btn-sm" type="button" data-action="remove-line">Remove</button></div>';
  }
  function linesSection(items,withCost,initialLines) {
    modalItems=items;
    const rows=initialLines&&initialLines.length?initialLines.map(l=>lineRow(items,withCost,{item_id:l.item_id,quantity:l.quantity_ordered||l.quantity,unit_cost:l.unit_cost})).join(''):lineRow(items,withCost);
    return '<div class="span-2"><label class="lbl">Items</label><div data-lines="'+(withCost?'purchase':'basic')+'">'+rows+'</div><button class="btn btn-ghost btn-sm" type="button" data-action="add-line" data-cost="'+(withCost?'1':'0')+'">Add another item</button></div>';
  }
  function readLines(form,withCost) {
    return $$('[data-line-row]',form).map(row=>{
      const value={item_id:Number($('[name="item_id"]',row).value),quantity:Number($('[name="quantity"]',row).value)};
      if(withCost)value.unit_cost=Number($('[name="unit_cost"]',row).value);
      return value;
    }).filter(x=>x.item_id&&x.quantity>0);
  }
  async function itemDialog(item) {
    const cats=await records('categories',{order:'name.asc'});
    if(!cats.length){toast('Add a category before creating an item.',true);return;}
    const body='<div class="form-grid">'+field('code','Item code',{value:item&&item.code||'',placeholder:'Leave blank to generate'})+field('name','Item name',{value:item&&item.name||'',required:true})+field('category_id','Category',{type:'select',required:true,value:item&&item.category_id,options:cats.map(c=>({value:c.id,label:c.name}))})+field('unit','Unit',{value:item&&item.unit||'',required:true})+field('min_stock','Minimum stock',{type:'number',min:0,step:1,value:item&&item.min_stock||0,required:true})+(item?field('active','State',{type:'select',value:String(item.active),options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]}):'')+'</div>';
    openForm(item?'Edit item':'Add item',body,async fd=>{
      const v={code:fd.get('code'),name:String(fd.get('name')).trim(),category_id:Number(fd.get('category_id')),unit:String(fd.get('unit')).trim(),min_stock:Number(fd.get('min_stock'))};
      if(item){v.active=fd.get('active')==='true';await api.update('items',{id:'eq.'+item.id},v);}
      else await api.rpc('create_item',{p_code:v.code,p_name:v.name,p_category_id:v.category_id,p_unit:v.unit,p_min_stock:v.min_stock});
    });
  }
  async function supplierDialog(s) {
    openForm(s?'Edit supplier':'Add supplier','<div class="form-grid">'+field('name','Supplier name',{value:s&&s.name||'',required:true})+field('contact','Contact person',{value:s&&s.contact||''})+field('phone','Phone',{value:s&&s.phone||''})+'</div>',async fd=>{
      const v={name:String(fd.get('name')).trim(),contact:String(fd.get('contact')||'').trim(),phone:String(fd.get('phone')||'').trim()};
      if(s)await api.update('suppliers',{id:'eq.'+s.id},v);else await api.insert('suppliers',v);
    });
  }
  async function purchaseDialog(id) {
    const [suppliers,items,purchase,lines]=await Promise.all([records('suppliers',{active:'eq.true',order:'name.asc'}),records('items',{active:'eq.true',order:'name.asc'}),id?api.one('purchases',{id:'eq.'+id}):Promise.resolve(null),id?records('purchase_lines',{purchase_id:'eq.'+id,limit:'100'}):Promise.resolve([])]);
    if(!suppliers.length||!items.length){toast('Create an active supplier and item first.',true);return;}
    if(id&&(!purchase||purchase.status!=='ordered'||lines.some(l=>Number(l.quantity_received)>0))){toast('A purchase can only be edited before any goods are received.',true);return;}
    const body='<div class="form-grid">'+field('supplier_id','Supplier',{type:'select',required:true,value:purchase&&purchase.supplier_id,options:suppliers.map(s=>({value:s.id,label:s.name}))})+field('purchase_date','Purchase date',{type:'date',value:purchase?purchase.purchase_date:localDateISO(),required:true})+field('invoice_ref','Invoice reference',{value:purchase&&purchase.invoice_ref||''})+field('notes','Notes',{type:'textarea',wide:true,value:purchase&&purchase.notes||''})+linesSection(items,true,lines)+'</div>';
    openForm(id?'Edit purchase '+purchase.number:'New purchase',body,async fd=>{
      const lines=readLines($('#modal-form'),true).map(x=>({item_id:x.item_id,quantity_ordered:x.quantity,unit_cost:x.unit_cost}));
      if(!lines.length)throw new Error('Add at least one purchase line.');
      const args={p_supplier_id:Number(fd.get('supplier_id')),p_purchase_date:fd.get('purchase_date'),p_invoice_ref:fd.get('invoice_ref'),p_notes:fd.get('notes'),p_lines:lines};
      await api.rpc(id?'update_purchase':'create_purchase',id?{p_purchase_id:Number(id),...args}:args);
    },id?'Save purchase':'Create purchase');
  }
  async function receivePurchase(id) {
    const [p,lines,items]=await Promise.all([api.one('purchases',{id:'eq.'+id}),records('purchase_lines',{purchase_id:'eq.'+id,limit:'100'}),records('items',{order:'name.asc'})]);
    const im=new Map(items.map(i=>[i.id,i]));
    openForm('Receive purchase '+(p&&p.number||''),'<p class="muted">Enter the quantity received for each line. Stock and purchase totals update together.</p>'+table(['Item','Ordered','Received','Outstanding','Receive now'],lines.map(l=>{const i=im.get(l.item_id)||{};const remaining=l.quantity_ordered-l.quantity_received;return '<tr><td>'+esc(i.name||'')+'</td><td>'+l.quantity_ordered+'</td><td>'+l.quantity_received+'</td><td>'+remaining+'</td><td><input class="input" type="number" min="0" max="'+remaining+'" value="0" data-receive-line="'+l.id+'"></td></tr>';})),async()=>{
      const receipts=$$('[data-receive-line]',dialog).map(i=>({line_id:Number(i.dataset.receiveLine),quantity:Number(i.value)})).filter(x=>x.quantity>0);
      if(!receipts.length)throw new Error('Enter at least one received quantity.');
      await api.rpc('receive_purchase',{p_purchase_id:Number(id),p_receipts:receipts});
    },'Post receipt');
  }
  async function issueDialog() {
    const [items,branches]=await Promise.all([records('items',{active:'eq.true',order:'name.asc'}),records('branches',{active:'eq.true',order:'name.asc'})]);
    if(!items.length||!branches.length){toast('Create an active branch and item first.',true);return;}
    const body='<div class="form-grid">'+field('branch_id','Stock branch',{type:'select',required:true,value:profile.branch_id,options:branches.map(b=>({value:b.id,label:b.name}))})+field('recipient','Recipient',{required:true})+field('department','Department')+field('issue_date','Issue date',{type:'date',value:localDateISO(),required:true})+field('purpose','Purpose',{type:'textarea',wide:true})+linesSection(items,false)+'</div>';
    openForm('Issue items',body,async fd=>{
      const lines=readLines($('#modal-form'),false).map(x=>({item_id:x.item_id,quantity:x.quantity}));
      if(!lines.length)throw new Error('Add at least one issue line.');
      await api.rpc('create_office_issue',{p_branch_id:Number(fd.get('branch_id')),p_recipient:fd.get('recipient'),p_department:fd.get('department'),p_issue_date:fd.get('issue_date'),p_purpose:fd.get('purpose'),p_lines:lines});
    },'Issue stock');
  }
  async function adjustmentDialog() {
    const [items,branches]=await Promise.all([records('items',{active:'eq.true',order:'name.asc'}),records('branches',{active:'eq.true',order:'name.asc'})]);
    openForm('Correct stock','<div class="form-grid">'+field('branch_id','Branch',{type:'select',required:true,value:profile.branch_id,options:branches.map(b=>({value:b.id,label:b.name}))})+field('item_id','Item',{type:'select',required:true,options:items.map(i=>({value:i.id,label:i.code+' — '+i.name}))})+field('direction','Correction',{type:'select',options:[{value:'add',label:'Add stock'},{value:'remove',label:'Remove stock'}]})+field('quantity','Quantity',{type:'number',min:1,step:1,required:true})+field('reason','Reason',{type:'select',options:[{value:'count_difference',label:'Count difference'},{value:'damaged',label:'Damaged'},{value:'expired',label:'Expired'},{value:'found',label:'Found'},{value:'other',label:'Other'}]})+field('note','Note',{type:'textarea',wide:true})+'</div>',async fd=>{
      await api.rpc('create_stock_adjustment',{p_branch_id:Number(fd.get('branch_id')),p_item_id:Number(fd.get('item_id')),p_direction:fd.get('direction'),p_quantity:Number(fd.get('quantity')),p_reason:fd.get('reason'),p_note:fd.get('note')});
    },'Post correction');
  }
  async function requestDialog() {
    const items=await records('items',{active:'eq.true',order:'name.asc'});
    openForm('New branch request','<div class="form-grid">'+field('notes','Notes',{type:'textarea',wide:true})+linesSection(items,false)+'</div>',async fd=>{
      const lines=readLines($('#modal-form'),false).map(x=>({item_id:x.item_id,quantity:x.quantity}));
      if(!lines.length)throw new Error('Add at least one request line.');
      await api.rpc('create_branch_request',{p_notes:fd.get('notes'),p_lines:lines});
    },'Submit request');
  }
  async function reviewRequest(id) {
    const [r,lines,items]=await Promise.all([api.one('requests',{id:'eq.'+id}),records('request_lines',{request_id:'eq.'+id,limit:'100'}),records('items',{order:'name.asc'})]), im=new Map(items.map(i=>[i.id,i]));
    const body='<p>Approve the full request, reduce quantities, or set a line to zero.</p>'+table(['Item','Requested','Approve','Reason'],lines.map(l=>'<tr><td>'+esc((im.get(l.item_id)||{}).name||'')+'</td><td>'+l.quantity_requested+'</td><td><input class="input" type="number" min="0" max="'+l.quantity_requested+'" value="'+l.quantity_requested+'" data-approve-line="'+l.id+'"></td><td><input class="input" type="text" maxlength="200" data-reason-line="'+l.id+'"></td></tr>'));
    openForm('Review request '+(r&&r.number||''),body,async()=>{
      const decisions=$$('[data-approve-line]',dialog).map(e=>({line_id:Number(e.dataset.approveLine),quantity_approved:Number(e.value),reason:$('[data-reason-line="'+e.dataset.approveLine+'"]',dialog).value}));
      await api.rpc('review_branch_request',{p_request_id:Number(id),p_decisions:decisions,p_reject:false});
    },'Approve quantities');
  }
  async function dispatchDialog() {
    const [items,branches,requests]=await Promise.all([records('items',{active:'eq.true',order:'name.asc'}),records('branches',{active:'eq.true',order:'name.asc'}),records('requests',{status:'in.(approved,partly_approved)',order:'created_at.desc'})]);
    const destinations=branches.filter(b=>b.type!=='main');
    openForm('New dispatch','<div class="form-grid">'+field('destination_id','Destination',{type:'select',required:true,options:destinations.map(b=>({value:b.id,label:b.name}))})+field('request_id','Approved request (optional)',{type:'select',options:requests.map(r=>({value:r.id,label:r.number}))})+field('dispatch_date','Dispatch date',{type:'date',value:localDateISO(),required:true})+linesSection(items,false)+'</div>',async fd=>{
      const lines=readLines($('#modal-form'),false).map(x=>({item_id:x.item_id,quantity:x.quantity}));if(!lines.length)throw new Error('Add at least one dispatch line.');
      await api.rpc('create_dispatch',{p_destination_id:Number(fd.get('destination_id')),p_dispatch_date:fd.get('dispatch_date'),p_request_id:fd.get('request_id')?Number(fd.get('request_id')):null,p_lines:lines});
    },'Dispatch stock');
  }
  async function receiveDispatch(id) {
    const [d,lines,items]=await Promise.all([api.one('dispatches',{id:'eq.'+id}),records('dispatch_lines',{dispatch_id:'eq.'+id,limit:'100'}),records('items',{order:'name.asc'})]),im=new Map(items.map(i=>[i.id,i]));
    const body='<p>Confirm what arrived. The remaining quantity is recorded as damaged or missing and stays in transit until closed.</p>'+table(['Item','Sent','Received','Damaged','Note'],lines.map(l=>'<tr><td>'+esc((im.get(l.item_id)||{}).name||'')+'</td><td>'+l.quantity_sent+'</td><td><input class="input" type="number" min="0" max="'+l.quantity_sent+'" value="'+l.quantity_sent+'" data-received="'+l.id+'"></td><td><input class="input" type="number" min="0" max="'+l.quantity_sent+'" value="0" data-damaged="'+l.id+'"></td><td><input class="input" type="text" maxlength="200" data-note="'+l.id+'"></td></tr>'));
    openForm('Receive '+(d&&d.reference||'dispatch'),body,async()=>{
      const receipts=$$('[data-received]',dialog).map(e=>({line_id:Number(e.dataset.received),received:Number(e.value),damaged:Number($('[data-damaged="'+e.dataset.received+'"]',dialog).value),note:$('[data-note="'+e.dataset.received+'"]',dialog).value}));
      await api.rpc('receive_dispatch',{p_dispatch_id:Number(id),p_receipts:receipts});
    },'Confirm receipt');
  }
  async function closeDispatch(id) {
    openForm('Close dispatch','<div class="form-grid">'+field('resolution','Resolve damaged or missing items',{type:'select',options:[{value:'write_off',label:'Write off'},{value:'return_to_main',label:'Return to main office'}]})+field('note','Note',{type:'textarea',wide:true})+'</div>',async fd=>api.rpc('close_dispatch',{p_dispatch_id:Number(id),p_resolution:fd.get('resolution'),p_note:fd.get('note')}),'Close dispatch');
  }
  async function cashRequestDialog() {
    openForm('Request petty cash','<div class="form-grid">'+field('amount','Amount (Rs.)',{type:'number',min:'0.01',step:'0.01',required:true})+field('purpose','Purpose',{type:'textarea',wide:true})+'</div>',async fd=>api.rpc('create_petty_cash_request',{p_amount:Number(fd.get('amount')),p_purpose:fd.get('purpose')}),'Submit request');
  }
  async function cashExpenseDialog() {
    openForm('Record petty cash spending','<div class="form-grid">'+field('amount','Amount (Rs.)',{type:'number',min:'0.01',step:'0.01',required:true})+field('entry_date','Date',{type:'date',value:localDateISO(),required:true})+field('description','Description',{type:'textarea',wide:true,required:true})+'</div>',async fd=>api.rpc('record_petty_cash_expense',{p_amount:Number(fd.get('amount')),p_description:fd.get('description'),p_entry_date:fd.get('entry_date')}),'Record spending');
  }
  async function cashReviewDialog(id) {
    const r=await api.one('petty_cash_requests',{id:'eq.'+id});
    const body='<p>Requested amount: <b>'+cash(r.amount_requested)+'</b></p><div class="form-grid">'+field('approve','Decision',{type:'select',options:[{value:'true',label:'Approve'},{value:'false',label:'Reject'}]})+field('amount','Approved amount (Rs.)',{type:'number',min:0,step:'0.01',value:r.amount_requested})+field('note','Reason or note',{type:'textarea',wide:true})+'</div>';
    openForm('Review '+r.number,body,async fd=>api.rpc('review_petty_cash_request',{p_request_id:Number(id),p_approve:fd.get('approve')==='true',p_amount:Number(fd.get('amount')),p_note:fd.get('note')}),'Save review');
  }
  async function branchDialog(row) {
    const isMain=row&&row.type==='main';
    openForm(row?'Edit branch':'Add branch','<div class="form-grid">'+field('name','Name',{value:row&&row.name||'',required:true})+field('code','Code',{value:row&&row.code||'',required:true})+field('type','Type',{type:'select',value:row&&row.type||'branch',options:[{value:'main',label:'Main office'},{value:'branch',label:'Branch'}]})+field('phone','Phone',{value:row&&row.phone||''})+field('address','Address',{type:'textarea',wide:true,value:row&&row.address||''})+field('active','State',{type:'select',value:String(row?row.active:true),options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]})+'</div>',async fd=>{
      const v={name:String(fd.get('name')).trim(),code:String(fd.get('code')).trim().toUpperCase(),type:fd.get('type'),phone:String(fd.get('phone')||'').trim(),address:String(fd.get('address')||'').trim(),active:fd.get('active')==='true'};
      if(row)await api.update('branches',{id:'eq.'+row.id},v);else await api.insert('branches',v);
    });
  }
  async function categoryDialog(row) {
    openForm(row?'Rename category':'Add category',field('name','Category name',{value:row&&row.name||'',required:true}),async fd=>{
      const value={name:String(fd.get('name')).trim()};
      if(row)await api.update('categories',{id:'eq.'+row.id},value);else await api.insert('categories',value);
    });
  }
  async function roleDialog(row) {
    const side=row?row.side:'main', selected=new Set(row&&row.permissions||[]);
    const permissionHtml=(currentSide,granted)=>PERMS.filter(p=>currentSide==='branch'?['requests.create','dispatches.receive','petty_cash.request'].includes(p[0]):p[0]!=='requests.create'&&p[0]!=='dispatches.receive')
      .map(p=>'<label><input type="checkbox" name="permissions" value="'+esc(p[0])+'" '+(granted.has(p[0])?'checked':'')+'> '+esc(p[1])+'</label>').join('');
    const checks=permissionHtml(side,selected);
    openForm(row?'Edit role':'Add role','<div class="form-grid">'+field('key','Role key',{value:row&&row.key||'',required:true,help:'Use lowercase letters, numbers, and underscores.'})+field('name','Role name',{value:row&&row.name||'',required:true})+field('side','Role side',{type:'select',value:side,options:[{value:'main',label:'Main office'},{value:'branch',label:'Branch'}]})+field('description','Description',{type:'textarea',wide:true,value:row&&row.description||''})+'<div class="span-2"><label class="lbl">Permissions</label><div class="permission-list">'+checks+'</div></div></div>',async fd=>{
      const granted=$$('[name="permissions"]:checked',dialog).map(x=>x.value),v={key:String(fd.get('key')).trim().toLowerCase(),name:String(fd.get('name')).trim(),name_key:String(fd.get('name')).trim().toLowerCase(),side:fd.get('side'),description:String(fd.get('description')||'').trim(),permissions:granted};
      if(row)await api.update('roles',{key:'eq.'+row.key},v);else await api.insert('roles',v);
    });
    const sideSelect=$('[name="side"]',dialog),permissionBox=$('.permission-list',dialog);
    sideSelect.addEventListener('change',()=>{
      const granted=new Set($$('[name="permissions"]:checked',permissionBox).map(x=>x.value));
      permissionBox.innerHTML=permissionHtml(sideSelect.value,granted);
    });
    permissionBox.addEventListener('change',ev=>{
      if(!ev.target.matches('input[name="permissions"]'))return;
      const needs={'items.manage':['items.view'],'suppliers.manage':['suppliers.view'],'purchases.manage':['purchases.view'],'purchases.receive':['purchases.view'],'issues.manage':['issues.view'],'stock.adjust':['stock.view'],'petty_cash.approve':['petty_cash.view'],'petty_cash.configure':['petty_cash.view']};
      const box=p=>permissionBox.querySelector('[value="'+p+'"]');
      if(ev.target.checked)(needs[ev.target.value]||[]).forEach(p=>{if(box(p))box(p).checked=true;});
      else Object.entries(needs).filter(([,required])=>required.includes(ev.target.value)).forEach(([p])=>{if(box(p))box(p).checked=false;});
    });
  }
  async function userDialog(row) {
    const [branches,roles]=await Promise.all([records('branches',{order:'name.asc'}),records('roles',{order:'name.asc'})]);
    if(row)roles.unshift({key:'super_admin',name:'Super Admin',side:'main',permissions:PERMS.map(x=>x[0])});
    const roleFor=key=>roles.find(r=>r.key===key)||roles[0];
    const initialRole=roleFor(row&&row.role_key);
    const branchOptions=r=>branches.filter(b=>b.type===(r&&r.side==='branch'?'branch':'main')).map(b=>({value:b.id,label:b.name}));
    const permissionHtml=(side,selected)=>PERMS.filter(p=>side==='branch'?['requests.create','dispatches.receive','petty_cash.request'].includes(p[0]):p[0]!=='requests.create'&&p[0]!=='dispatches.receive')
      .map(p=>'<label><input type="checkbox" name="user_permissions" value="'+esc(p[0])+'" '+(selected.includes(p[0])?'checked':'')+'> '+esc(p[1])+'</label>').join('');
    const custom=!!row&&Array.isArray(row.permissions)&&row.role_key!=='super_admin';
    const initialPermissions=custom?row.permissions:(initialRole&&initialRole.permissions||[]);
    const body='<div class="form-grid">'+(row?field('name','Name',{value:row.name,required:true})+'<div class="field"><label class="lbl">Account email</label><input value="'+esc(row.email)+'" disabled></div>':field('name','Name',{required:true})+(field('email','Email',{type:'email',required:true})+field('password','Temporary password',{type:'password',required:true,help:'At least 12 characters; shared only with the new user.'})))+field('role_key','Role',{type:'select',required:true,value:initialRole&&initialRole.key,options:roles.map(r=>({value:r.key,label:r.name}))})+field('branch_id','Branch',{type:'select',required:true,value:row&&row.branch_id,options:branchOptions(initialRole)})+field('active','Access',{type:'select',value:String(row?row.active:false),options:[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]})+'</div>'+(initialRole&&initialRole.key!=='super_admin'?'<section class="permission-editor"><label class="permission-toggle"><input id="custom-permissions" type="checkbox" '+(custom?'checked':'')+'> Customize this user’s permissions</label><div id="user-permissions" class="permission-list">'+permissionHtml(initialRole.side,initialPermissions)+'</div></section>':'<p class="muted small">Super Admin access is reserved for the one-time bootstrap and existing Super Admin accounts.</p>')+(row?'<div style="margin-top:1rem">'+btn('Send password reset email','user-reset','btn btn-secondary',row.id)+'</div>':'<p class="muted small">The Auth account is created through Supabase. A profile receives the selected role and branch; the password is never saved by Office Stock.</p>');
    openForm(row?'Edit user access':'Create user',body,async fd=>{
      const roleKey=fd.get('role_key'),roleRow=roleFor(roleKey);
      if(!roleRow)throw new Error('Choose a valid role.');
      const permissions=roleRow.key==='super_admin'||!$('#custom-permissions',dialog)?.checked?null:$$('[name="user_permissions"]:checked',dialog).map(x=>x.value);
      const name=String(fd.get('name')||'').trim();
      if(row)await api.update('profiles',{id:'eq.'+row.id},{name,role_key:roleKey,permissions,branch_id:Number(fd.get('branch_id')),active:fd.get('active')==='true'});
      else {
        if(String(fd.get('password')).length<12)throw new Error('Use at least 12 characters for the temporary password.');
        const created=await api.signUp(name,fd.get('email'),fd.get('password'));
        const uid=created&&created.user&&created.user.id;
        if(!uid)throw new Error('Supabase did not return a new user ID. Check that sign-ups are enabled and the email is not already registered.');
        await api.update('profiles',{id:'eq.'+uid},{name,role_key:roleKey,permissions,branch_id:Number(fd.get('branch_id')),active:fd.get('active')==='true'});
      }
    },row?'Save access':'Create account');
    const roleSelect=$('[name="role_key"]',dialog),branchSelect=$('[name="branch_id"]',dialog),customToggle=$('#custom-permissions',dialog),permissionBox=$('#user-permissions',dialog);
    if(customToggle){
      const syncToggle=()=>{permissionBox.querySelectorAll('input').forEach(x=>x.disabled=!customToggle.checked);};
      customToggle.addEventListener('change',syncToggle);syncToggle();
      permissionBox.addEventListener('change',ev=>{
        if(!ev.target.matches('input[name="user_permissions"]'))return;
        const needs={'items.manage':['items.view'],'suppliers.manage':['suppliers.view'],'purchases.manage':['purchases.view'],'purchases.receive':['purchases.view'],'issues.manage':['issues.view'],'stock.adjust':['stock.view'],'petty_cash.approve':['petty_cash.view'],'petty_cash.configure':['petty_cash.view']};
        const box=p=>permissionBox.querySelector('[value="'+p+'"]');
        if(ev.target.checked)(needs[ev.target.value]||[]).forEach(p=>{if(box(p))box(p).checked=true;});
        else Object.entries(needs).filter(([,required])=>required.includes(ev.target.value)).forEach(([p])=>{if(box(p))box(p).checked=false;});
      });
      roleSelect.addEventListener('change',()=>{
        const r=roleFor(roleSelect.value);branchSelect.innerHTML='<option value="">Choose…</option>'+branchOptions(r).map(o=>'<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>').join('');
        permissionBox.innerHTML=permissionHtml(r.side,r.permissions||[]);customToggle.checked=false;customToggle.closest('.permission-editor').hidden=r.key==='super_admin';syncToggle();
      });
    }
  }
  async function passwordDialog() {
    openForm('Change password','<div class="form-grid">'+field('password','New password',{type:'password',required:true,help:'Use at least 12 characters.'})+field('confirm','Confirm password',{type:'password',required:true})+'</div>',async fd=>{
      const p=String(fd.get('password'));if(p.length<12)throw new Error('Use at least 12 characters.');if(p!==fd.get('confirm'))throw new Error('The passwords do not match.');await api.changePassword(p);
    },'Change password');
  }
  async function emailDialog() {
    openForm('Change email','<p class="muted">Supabase will verify the new address before it becomes your sign-in email.</p>'+field('email','New email address',{type:'email',required:true,value:profile.email}),async fd=>{
      const email=String(fd.get('email')).trim().toLowerCase();
      if(email===String(profile.email).toLowerCase())throw new Error('Enter a different email address.');
      await api.changeEmail(email);
    },'Send verification');
  }
  async function runAction(action,id,source) {
    if(action==='show-signup')return renderSignup();
    if(action==='show-login')return renderLogin();
    if(action==='show-reset')return renderReset();
    if(action==='edit-connection'){await api.signOut();profile=null;role=null;branch=null;return renderSetup();}
    if(action==='retry-profile')return hydrate();
    if(action==='refresh')return loadScreen();
    if(action==='close-modal')return dialog.close();
    if(action==='add-line'){const box=$('[data-lines]',dialog);if(box)box.insertAdjacentHTML('beforeend',lineRow(modalItems,$('[data-cost]',dialog)?.dataset.cost==='1'));return;}
    if(action==='remove-line'){if($$('[data-line-row]',dialog).length>1)source.closest('[data-line-row]').remove();return;}
    if(action==='logout'){await api.signOut();profile=null;role=null;branch=null;return renderLogin();}
    if(action==='item-new')return itemDialog();
    if(action==='item-edit')return itemDialog(await api.one('items',{id:'eq.'+id}));
    if(action==='item-toggle'){const i=await api.one('items',{id:'eq.'+id});await api.update('items',{id:'eq.'+id},{active:!i.active});invalidate();return loadScreen();}
    if(action==='category-new')return categoryDialog();
    if(action==='category-edit')return categoryDialog(await api.one('categories',{id:'eq.'+id}));
    if(action==='category-delete'){if(!confirm('Delete this category? Categories used by items cannot be deleted.'))return;await api.remove('categories',{id:'eq.'+id});invalidate();return loadScreen();}
    if(action==='item-delete'){if(!confirm('Delete this item? Items with movement history will be deactivated instead.'))return;await api.rpc('delete_item',{p_item_id:Number(id)});invalidate();return loadScreen();}
    if(action==='supplier-new')return supplierDialog();
    if(action==='supplier-edit')return supplierDialog(await api.one('suppliers',{id:'eq.'+id}));
    if(action==='supplier-toggle'){const s=await api.one('suppliers',{id:'eq.'+id});await api.update('suppliers',{id:'eq.'+id},{active:!s.active});invalidate();return loadScreen();}
    if(action==='supplier-delete'){if(!confirm('Delete this supplier? Suppliers used by purchases will be deactivated instead.'))return;await api.rpc('delete_supplier',{p_supplier_id:Number(id)});invalidate();return loadScreen();}
    if(action==='purchase-new')return purchaseDialog();
    if(action==='purchase-edit')return purchaseDialog(id);
    if(action==='purchase-receive')return receivePurchase(id);
    if(action==='purchase-cancel'){if(!confirm('Cancel this purchase?'))return;await api.rpc('cancel_purchase',{p_purchase_id:Number(id)});invalidate();return loadScreen();}
    if(action==='issue-new')return issueDialog();
    if(action==='issue-cancel'){const reason=prompt('Reason for cancelling this issue:','');if(reason===null)return;await api.rpc('cancel_office_issue',{p_issue_id:Number(id),p_reason:reason});invalidate();return loadScreen();}
    if(action==='stock-adjust')return adjustmentDialog();
    if(action==='request-new')return requestDialog();
    if(action==='request-review')return reviewRequest(id);
    if(action==='request-cancel'){if(!confirm('Withdraw this request?'))return;await api.rpc('cancel_branch_request',{p_request_id:Number(id)});invalidate();return loadScreen();}
    if(action==='dispatch-new')return dispatchDialog();
    if(action==='dispatch-receive')return receiveDispatch(id);
    if(action==='dispatch-close')return closeDispatch(id);
    if(action==='cash-request')return cashRequestDialog();
    if(action==='cash-expense')return cashExpenseDialog();
    if(action==='cash-review')return cashReviewDialog(id);
    if(action==='cash-cancel'){if(!confirm('Withdraw this request?'))return;await api.rpc('cancel_petty_cash_request',{p_request_id:Number(id)});invalidate();return loadScreen();}
    if(action==='cash-reverse'){if(!confirm('Post a reversal for this expense?'))return;await api.rpc('reverse_petty_cash_expense',{p_entry_id:Number(id)});invalidate();return loadScreen();}
    if(action==='branch-new')return branchDialog(null);
    if(action==='branch-edit')return branchDialog(await api.one('branches',{id:'eq.'+id}));
    if(action==='branch-delete'){if(!confirm('Delete this branch? Branches with users or transaction history cannot be deleted.'))return;await api.remove('branches',{id:'eq.'+id});invalidate();return loadScreen();}
    if(action==='user-new')return userDialog(null);
    if(action==='user-edit')return userDialog(await api.one('profiles',{id:'eq.'+id}));
    if(action==='user-reset'){const u=await api.one('profiles',{id:'eq.'+id});await api.sendPasswordReset(u.email);return toast('If the email is registered, Supabase will send a password reset link.');}
    if(action==='role-new')return roleDialog(null);
    if(action==='role-edit')return roleDialog(await api.one('roles',{key:'eq.'+id}));
    if(action==='role-delete'){if(!confirm('Delete this role? Users assigned to it must be moved first.'))return;await api.remove('roles',{key:'eq.'+id});invalidate();return loadScreen();}
    if(action==='password-change')return passwordDialog();
    if(action==='email-change')return emailDialog();
    if(action==='report-export')return exportReport();
    if(action==='retention-run'){
      if(!confirm('Remove stock movements older than 30 days after preserving their net balances? This cleanup is permanent.'))return;
      const result=await api.rpc('prune_stock_ledger');invalidate();await loadScreen();
      toast(result&&result.skipped?'Retention cleanup is already running.':'Stock movement retention completed.');return;
    }
    if(action==='audit-clear')return auditClearDialog();
  }
  function exportReport() {
    const report=window.currentReport;if(!report)return;
    const quote=x=>'"'+String(x==null?'':x).replaceAll('"','""')+'"';
    const csv=[report.columns.map(c=>quote(c[1])).join(',')].concat(report.rows.map(r=>report.columns.map(([key])=>quote(r[key])).join(','))).join('\r\n');
    const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download='office-stock-'+report.type+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }
  document.addEventListener('click',async ev=>{
    const nav=ev.target.closest('[data-screen]');if(nav){ev.preventDefault();setScreen(nav.dataset.screen);return;}
    const action=ev.target.closest('[data-action]');if(!action)return;
    try{await runAction(action.dataset.action,action.dataset.id,action);}catch(error){toast(errorMsg(error),true);}
  });
  document.addEventListener('submit',async ev=>{
    const form=ev.target;if(!form||!form.id)return;
    if(form.id==='setup-form'){
      ev.preventDefault();const submit=$('button[type="submit"]',form);submit.disabled=true;submit.textContent='Checking…';
      try{const fd=new FormData(form);await window.officeStock.settings.validateAndSave({url:fd.get('url'),publishableKey:fd.get('publishableKey')});window.location.reload();}
      catch(e){renderSetup(errorMsg(e));}return;
    }
    if(form.id==='login-form'){
      ev.preventDefault();const fd=new FormData(form),submit=$('button[type="submit"]',form);submit.disabled=true;submit.textContent='Signing in…';
      try{await api.signIn(fd.get('email'),fd.get('password'));await hydrate();}
      catch(e){renderLogin(errorMsg(e));}return;
    }
    if(form.id==='signup-form'){
      ev.preventDefault();const fd=new FormData(form),submit=$('button[type="submit"]',form);submit.disabled=true;submit.textContent='Creating…';
      try{if(String(fd.get('password')).length<12)throw new Error('Use at least 12 characters for the password.');const result=await api.signUp(String(fd.get('name')).trim(),fd.get('email'),fd.get('password'));if(!result||!result.user)throw new Error('Supabase did not return a user. Check that sign-ups are enabled.');renderLogin('Account created. Confirm the email if required, then ask the administrator to activate your profile.');}
      catch(e){renderSignup(errorMsg(e));}return;
    }
    if(form.id==='reset-form'){
      ev.preventDefault();const fd=new FormData(form);
      try{await api.sendPasswordReset(fd.get('email'));renderReset('', 'If the address belongs to an account, Supabase will send a password reset link.');}
      catch(e){renderReset(errorMsg(e),'');}return;
    }
    if(form.id==='settings-form'){
      ev.preventDefault();try{const fd=new FormData(form);await api.rpc('update_app_settings',{p_company_name:String(fd.get('company_name')).trim(),p_branch_module_enabled:fd.get('branch_module_enabled')==='true',p_audit_logging_enabled:fd.get('audit_logging_enabled')==='true'});settings=await api.one('app_settings',{id:'eq.1'});invalidate();renderShell();toast('Settings saved.');}catch(e){toast(errorMsg(e),true);}return;
    }
    if(form.id==='low-level-form'){
      ev.preventDefault();try{const fd=new FormData(form);await api.rpc('set_petty_cash_low_level',{p_level:Number(fd.get('petty_cash_low_level'))});invalidate();await loadScreen();toast('Low balance threshold saved.');}catch(e){toast(errorMsg(e),true);}return;
    }
    if(form.id==='report-filter'){
      ev.preventDefault();const fd=new FormData(form);
      if(fd.get('from')&&fd.get('to')&&fd.get('from')>fd.get('to')){toast('The start date must be on or before the end date.',true);return;}
      reportState={type:fd.get('type'),from:fd.get('from'),to:fd.get('to'),by:fd.get('by'),branch:fd.get('branch'),supplier:fd.get('supplier')||'',department:fd.get('department')||'',low:fd.get('low')==='true'};
      return loadScreen();
    }
  });
  window.addEventListener('online',()=>{const b=$('#connection-banner');if(b)b.innerHTML='';});
  window.addEventListener('offline',()=>{const b=$('#connection-banner');if(b)b.innerHTML='<div class="alert alert-warning offline-banner">No internet connection. Office Stock uses the shared database and cannot save changes offline.</div>';});
  window.officeStock.auth.onCallback(handleAuthCallback);
  boot();
})();
