import './firebase-config.js';
import './wordset-action.js';
import { listenWordSets } from './wordset-action.js';
import { renderAll } from './wordset-render.js';

renderAll();
listenWordSets();
