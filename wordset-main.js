import './firebase-config.js';
import './wordset-action.js';
import { listenWordSets } from './wordset-action.js';
import { renderAll } from './wordset-render.js';
import { ensureSignedIn } from './wordset-auth.js';

renderAll();
listenWordSets();
ensureSignedIn().catch((error) => {
  console.error('匿名認証に失敗しました', error);
});
