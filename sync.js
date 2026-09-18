// ---------------------------------------------------------------------------
// Phillips Finance — shared cloud sync module (Tier 1: Supabase, magic-link auth)
//
// Loaded on every tracker page via:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
//   <script src="sync.js"></script>
// placed in <head>, BEFORE each page's own <script> block.
//
// Injects a small sign-in banner at the top of <body>, and exposes window.CloudSync
// with pull()/push() for each tracker's own script to call. Falls back to
// local-storage-only behaviour automatically if signed out, offline, or if the
// Supabase library fails to load — nothing here is required for the app to work.
// ---------------------------------------------------------------------------
(function(){
  const SUPABASE_URL = 'https://xagitxfheeyqqbqugkgy.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhhZ2l0eGZoZWV5cXFicXVna2d5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NjE1ODksImV4cCI6MjEwNTIzNzU4OX0.1k-BgNUYt97DSi7WcN--rVIbfzbSfHNK9gW_gEx5C78';
  const TABLE = 'tracker_data';

  if(!window.supabase || typeof window.supabase.createClient !== 'function'){
    // Supabase library didn't load (offline on first visit, CDN blocked, etc.) —
    // expose a no-op CloudSync so every tracker's calls degrade to local-only silently.
    window.CloudSync = {
      pull: async () => null,
      push: async () => {},
      isSignedIn: () => false,
      onAuthChange: () => {}
    };
    return;
  }

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let currentUser = null;
  let pendingEmail = null; // set once a code has been sent, until verified or restarted
  const authListeners = [];
  let sessionReadyResolve;
  const sessionReady = new Promise(res => { sessionReadyResolve = res; });

  function notifyAuthListeners(){
    authListeners.forEach(cb => { try{ cb(currentUser); }catch(e){ /* ignore listener errors */ } });
  }

  function $cs(id){ return document.getElementById(id); }

  function injectStyles(){
    const style = document.createElement('style');
    style.textContent = `
      #cloudSyncBanner{
        max-width:1180px;margin:0 auto 14px;padding:10px 14px;
        background:var(--panel-2, #1b2330);
        border:1px solid var(--border, #2a3444);
        border-radius:10px;
        color:var(--text, #eaeef4);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
        font-size:0.82rem;
        display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      }
      #cloudSyncBanner #csStatus{flex:1;min-width:200px;color:var(--muted, #96a2b8);}
      #cloudSyncBanner input[type="email"], #cloudSyncBanner input[type="text"]{
        max-width:220px;padding:7px 10px;border-radius:7px;
        border:1px solid var(--border, #2a3444);
        background:var(--panel, #151b24);
        color:var(--text, #eaeef4);
        font-size:0.82rem;outline:none;
      }
      #cloudSyncBanner input[type="email"]:focus, #cloudSyncBanner input[type="text"]:focus{border-color:var(--accent, #4aa8ff);}
      #cloudSyncBanner button{
        padding:7px 14px;border-radius:7px;border:none;cursor:pointer;
        font-weight:700;font-size:0.8rem;white-space:nowrap;
        background:var(--accent, #4aa8ff);color:#08221b;
      }
      #cloudSyncBanner button:hover{filter:brightness(1.08);}
      #cloudSyncBanner button.cs-secondary{
        background:none;border:1px solid var(--border, #2a3444);
        color:var(--muted, #96a2b8);font-weight:600;
      }
    `;
    document.head.appendChild(style);
  }

  function injectBanner(){
    injectStyles();
    const wrap = document.createElement('div');
    wrap.id = 'cloudSyncBanner';
    wrap.innerHTML = `
      <span id="csStatus"></span>
      <input type="email" id="csEmail" placeholder="you@email.com" style="display:none;">
      <button id="csSendLink" type="button" style="display:none;">Send code</button>
      <input type="text" id="csCode" placeholder="code from email" inputmode="numeric" autocomplete="one-time-code" maxlength="12" style="display:none;width:130px;">
      <button id="csVerifyCode" type="button" style="display:none;">Confirm code</button>
      <button id="csRestart" type="button" class="cs-secondary" style="display:none;">Use a different email</button>
      <button id="csSignOut" type="button" class="cs-secondary" style="display:none;">Sign out</button>
    `;
    document.body.insertBefore(wrap, document.body.firstChild);

    $cs('csSendLink').addEventListener('click', async () => {
      const emailEl = $cs('csEmail');
      const email = emailEl.value.trim();
      const statusEl = $cs('csStatus');
      if(!email) return;
      statusEl.textContent = 'Sending code…';
      try{
        const { error } = await client.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.href }
        });
        if(error){
          statusEl.textContent = 'Could not send code: ' + error.message;
        } else {
          pendingEmail = email;
          statusEl.textContent = `Check ${email} — on a Mac you can tap the link; on a home-screen app, type the code from that email below.`;
          updateVisibility();
        }
      }catch(e){
        statusEl.textContent = 'Could not reach the sync service — check your connection.';
      }
    });

    $cs('csEmail').addEventListener('keydown', (e) => {
      if(e.key === 'Enter') $cs('csSendLink').click();
    });

    $cs('csVerifyCode').addEventListener('click', async () => {
      const codeEl = $cs('csCode');
      const code = codeEl.value.trim();
      const statusEl = $cs('csStatus');
      if(!code || !pendingEmail) return;
      statusEl.textContent = 'Checking code…';
      try{
        const { error } = await client.auth.verifyOtp({ email: pendingEmail, token: code, type: 'email' });
        if(error){
          statusEl.textContent = "That code didn't work — check it and try again: " + error.message;
        }
        // on success, onAuthStateChange fires and renderBanner() takes over the status text
      }catch(e){
        statusEl.textContent = 'Could not reach the sync service — check your connection.';
      }
    });

    $cs('csCode').addEventListener('keydown', (e) => {
      if(e.key === 'Enter') $cs('csVerifyCode').click();
    });

    $cs('csRestart').addEventListener('click', () => {
      pendingEmail = null;
      $cs('csCode').value = '';
      $cs('csStatus').textContent = '☁ Not signed in — data stays on this device only.';
      updateVisibility();
    });

    $cs('csSignOut').addEventListener('click', async () => {
      try{ await client.auth.signOut(); }catch(e){ /* ignore */ }
      pendingEmail = null;
    });
  }

  function updateVisibility(){
    const emailEl = $cs('csEmail');
    if(!emailEl) return; // banner not injected yet (DOM not ready)
    const sendBtn = $cs('csSendLink');
    const codeEl = $cs('csCode');
    const verifyBtn = $cs('csVerifyCode');
    const restartBtn = $cs('csRestart');
    const outBtn = $cs('csSignOut');
    if(currentUser){
      emailEl.style.display = 'none';
      sendBtn.style.display = 'none';
      codeEl.style.display = 'none';
      verifyBtn.style.display = 'none';
      restartBtn.style.display = 'none';
      outBtn.style.display = 'inline-block';
    } else if(pendingEmail){
      emailEl.style.display = 'none';
      sendBtn.style.display = 'none';
      codeEl.style.display = 'inline-block';
      verifyBtn.style.display = 'inline-block';
      restartBtn.style.display = 'inline-block';
      outBtn.style.display = 'none';
    } else {
      emailEl.style.display = 'inline-block';
      sendBtn.style.display = 'inline-block';
      codeEl.style.display = 'none';
      verifyBtn.style.display = 'none';
      restartBtn.style.display = 'none';
      outBtn.style.display = 'none';
    }
  }

  function renderBanner(){
    const statusEl = $cs('csStatus');
    if(!statusEl) return; // banner not injected yet (DOM not ready)
    updateVisibility();
    if(currentUser){
      pendingEmail = null;
      statusEl.textContent = `☁ Synced as ${currentUser.email}`;
    } else if(!pendingEmail){
      statusEl.textContent = '☁ Not signed in — data stays on this device only.';
    }
    // if pendingEmail is set but no user yet, leave the status text as whatever
    // the send/verify handler above last set (the "check your email" message).
  }

  function onReady(fn){
    if(document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  onReady(() => {
    injectBanner();
    renderBanner();
  });

  client.auth.onAuthStateChange((_event, session) => {
    currentUser = session ? session.user : null;
    renderBanner();
    notifyAuthListeners();
  });

  client.auth.getSession().then(({data}) => {
    currentUser = data && data.session ? data.session.user : null;
    renderBanner();
    notifyAuthListeners();
    sessionReadyResolve();
  }).catch(() => {
    // offline on first load, or the auth check failed — proceed as signed-out
    sessionReadyResolve();
  });

  // ---------- pull / push ----------
  // Both wait for the initial session check to finish first, so a page that loads
  // and calls pull() immediately doesn't race ahead of session restoration and
  // wrongly treat an already-signed-in user as signed out.
  async function pull(tracker){
    await sessionReady;
    if(!currentUser) return null;
    try{
      const { data, error } = await client
        .from(TABLE)
        .select('state')
        .eq('tracker', tracker)
        .maybeSingle();
      if(error || !data) return null;
      return data.state;
    }catch(e){
      return null; // offline, or the request failed — caller falls back to local data
    }
  }

  async function push(tracker, state){
    await sessionReady;
    if(!currentUser) return;
    try{
      await client.from(TABLE).upsert({
        user_id: currentUser.id,
        tracker,
        state,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,tracker' });
    }catch(e){
      // offline, or the request failed — the local save already succeeded, so
      // nothing is lost; it'll sync next time push() succeeds.
    }
  }

  window.CloudSync = {
    pull,
    push,
    isSignedIn: () => !!currentUser,
    onAuthChange: (cb) => {
      authListeners.push(cb);
      sessionReady.then(() => cb(currentUser));
    }
  };
})();
