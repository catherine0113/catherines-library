// Cross-device sync with Firebase (Auth + Firestore).
// Data layout: users/{uid}/books/{bookId} and users/{uid}/meta/main
// Deleted books are kept as small "tombstones" ({deleted:true}) so deletions reach every device.
const V = '13.4.0';
const App = window.LibApp;
const cfg = window.FIREBASE_CONFIG;

if (!App) {
  // app script failed; nothing to do
} else if (!cfg || !cfg.apiKey) {
  App.status({ state: 'off' });
} else {
  const fail = e => {
    console.error(e);
    const who = App.remembered && App.remembered();
    // offline or the sync code couldn't load: you're still signed in, just not connected yet
    if (who) App.status({ state: 'in', email: who, offline: true });
    else App.status({ state: 'out', error: 'Sync could not start. Check your connection and reload.' });
    window.addEventListener('online', () => start().catch(fail), { once: true });
  };
  start().catch(fail);
}

async function start() {
  const [{ initializeApp, getApps, getApp }, A, F] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const app = getApps().length ? getApp() : initializeApp(cfg);
  // keep the sign-in saved on this device (IndexedDB, with localStorage as a backup) until you sign out
  let auth;
  try { auth = A.initializeAuth(app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence], popupRedirectResolver: A.browserPopupRedirectResolver }); }
  catch (e) { auth = A.getAuth(app); }
  try { await A.setPersistence(auth, A.indexedDBLocalPersistence); } catch (e) { try { await A.setPersistence(auth, A.browserLocalPersistence); } catch (_) {} }
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
  catch (e) { db = F.getFirestore(app); }

  // wait for the app to finish loading local data
  if (!App._loaded) await new Promise(r => { const prev = App.ready; App.ready = () => { prev && prev(); r(); }; setTimeout(r, 4000); });

  let uid = null, email = '', unsubs = [], synced = {}, metaSynced = '', ready = false, pushing = false, again = false;
  const clean = o => JSON.parse(JSON.stringify(o));
  const bookRef = id => F.doc(db, 'users', uid, 'books', id);
  const metaRef = () => F.doc(db, 'users', uid, 'meta', 'main');
  const errText = e => {
    const c = (e && e.code) || '';
    return ({
      'auth/invalid-credential': 'Wrong email or password.', 'auth/wrong-password': 'Wrong email or password.', 'auth/user-not-found': 'No account with that email — tap Create account.',
      'auth/email-already-in-use': 'That email already has an account — tap Sign in.', 'auth/weak-password': 'Password needs at least 6 characters.', 'auth/invalid-email': 'That email address looks wrong.',
      'auth/popup-blocked': 'The sign-in window was blocked. Allow pop-ups, or use email and password.', 'auth/popup-closed-by-user': 'Sign-in window was closed.',
      'auth/unauthorized-domain': 'This website isn’t allowed in Firebase yet (Authentication → Settings → Authorized domains).',
      'auth/operation-not-allowed': 'This sign-in method isn’t turned on in Firebase yet.', 'auth/network-request-failed': 'No connection. Try again when you’re online.',
    })[c] || (e && e.message) || 'Something went wrong.';
  };

  async function push() {
    if (!uid || !ready) return;
    if (pushing) { again = true; return; }
    pushing = true;
    try {
      do {
        again = false;
        const { books, meta } = App.state();
        const ops = [];
        for (const id in books) {
          const s = JSON.stringify(books[id]);
          if (synced[id] !== s) { books[id].updatedAt = Date.now(); const body = clean(books[id]); synced[id] = JSON.stringify(books[id]); ops.push([bookRef(id), body]); }
        }
        for (const id in synced) if (!(id in books) && synced[id] !== 'DEL') { synced[id] = 'DEL'; ops.push([bookRef(id), { deleted: true, updatedAt: Date.now() }]); }
        const m = JSON.stringify(meta);
        if (m !== metaSynced) { metaSynced = m; ops.push([metaRef(), clean(meta)]); }
        for (let i = 0; i < ops.length; i += 400) {
          const b = F.writeBatch(db);
          ops.slice(i, i + 400).forEach(([r, d]) => b.set(r, d));
          await b.commit();
        }
      } while (again);
    } catch (e) {
      console.error(e);
      if (e && e.code === 'permission-denied') App.toast('Sync blocked — check the Firestore rules');
      else if (e && /exceeds the maximum|too large/i.test(e.message || '')) App.toast('One book is too large to sync (try a smaller cover)');
    } finally { pushing = false; }
  }

  function subscribe() {
    let firstBooks = true, firstMeta = true;
    unsubs.push(F.onSnapshot(F.collection(db, 'users', uid, 'books'), { includeMetadataChanges: true }, snap => {
      App.status({ state: 'in', email, offline: snap.metadata.fromCache && !navigator.onLine });
      if (firstBooks) {
        if (snap.metadata.fromCache && snap.empty) return; // wait for the server
        firstBooks = false;
        const { books } = App.state();
        snap.docs.forEach(d => {
          const c = d.data(), id = d.id, l = books[id];
          if (c.deleted) {
            if (l && (l.updatedAt || 0) > (c.updatedAt || 0)) return; // edited here after it was deleted elsewhere: keep, will push
            synced[id] = 'DEL'; if (l) App.remoteBook(id, null);
          } else if (!l || (c.updatedAt || 0) >= (l.updatedAt || 0)) { App.remoteBook(id, c); synced[id] = JSON.stringify(App.state().books[id]); }
          // else: this device has the newer copy; push() will send it
        });
        ready = true; push();
        return;
      }
      snap.docChanges().forEach(ch => {
        if (ch.doc.metadata.hasPendingWrites) return; // our own write echoing back
        const id = ch.doc.id, c = ch.doc.data();
        if (ch.type === 'removed' || !c || c.deleted) { synced[id] = 'DEL'; if (App.state().books[id]) App.remoteBook(id, null); return; }
        const cur = App.state().books[id];
        if (cur && JSON.stringify(cur) === JSON.stringify(c)) { synced[id] = JSON.stringify(cur); return; }
        App.remoteBook(id, c); synced[id] = JSON.stringify(App.state().books[id]);
      });
    }, e => { console.error(e); App.status({ state: 'in', email, offline: true }); if (e.code === 'permission-denied') App.toast('Sync blocked — check the Firestore rules'); }));
    unsubs.push(F.onSnapshot(metaRef(), snap => {
      if (snap.metadata.hasPendingWrites) return;
      const m = snap.data();
      if (firstMeta) { firstMeta = false; if (!m) { metaSynced = ''; push(); return; } }
      if (m) { App.remoteMeta(m); metaSynced = JSON.stringify(App.state().meta); }
    }, e => console.error(e)));
  }

  A.onAuthStateChanged(auth, user => {
    unsubs.forEach(u => u()); unsubs = []; synced = {}; metaSynced = ''; ready = false;
    if (user) { uid = user.uid; email = user.email || ''; App.status({ state: 'in', email }); subscribe(); }
    else { uid = null; App.status({ state: 'out' }); }
  });

  window.addEventListener('online', () => uid && App.status({ state: 'in', email }));
  window.addEventListener('offline', () => uid && App.status({ state: 'in', email, offline: true }));

  window.LibSync = {
    push,
    async google() {
      try { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); App.toast('Signed in'); }
      catch (e) { App.status({ state: 'out', error: errText(e) }); }
    },
    async email(em, pw, mode) {
      try {
        if (mode === 'up') await A.createUserWithEmailAndPassword(auth, em, pw); else await A.signInWithEmailAndPassword(auth, em, pw);
        App.toast(mode === 'up' ? 'Account created — syncing' : 'Signed in');
      } catch (e) { App.status({ state: 'out', error: errText(e) }); }
    },
    async reset(em) {
      try { await A.sendPasswordResetEmail(auth, em); App.toast('Password reset email sent'); }
      catch (e) { App.status({ state: 'out', error: errText(e) }); }
    },
    async signOut() { await A.signOut(auth); App.toast('Signed out — books stay on this device'); },
  };
}
