'use strict';

const REGION = 'asia-northeast1';
const FIXED_TRIAL_PROJECT = 'wa-awesome-garden-stg';
const FIXED_TRIAL_ORIGIN = 'https://wa-awesome-garden-stg.web.app';
const MAX_ROOMS = 20;
const MAX_TRIAL_MILLIS = 7 * 24 * 60 * 60 * 1000;
const FORBIDDEN_PROJECTS = new Set(['wa-awesome', 'wa-awesome-mofumofu-stg']);
const CALLABLE_NAMES = Object.freeze([
  'floatingGardenCreateRoom', 'floatingGardenJoinRoom', 'floatingGardenStartMatch',
  'floatingGardenGetSnapshot', 'floatingGardenSubmitAction',
]);
const CONFIG_KEYS = Object.freeze(['enabled', 'projectId', 'region', 'previewOrigin', 'startsAtMillis', 'endsAtMillis', 'maxRooms']);
function validateTrialConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== CONFIG_KEYS.length || CONFIG_KEYS.some((key) => !Object.hasOwn(value, key))) throw new TypeError('Trial config must contain exactly the documented fields');
  if (typeof value.enabled !== 'boolean') throw new TypeError('Trial enabled must be explicit');
  if (typeof value.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.projectId) || FORBIDDEN_PROJECTS.has(value.projectId) || /(^|[-])(demo|local|localhost)([-]|$)/.test(value.projectId)) throw new TypeError('A dedicated trial project is required');
  if (value.region !== REGION || value.maxRooms !== MAX_ROOMS) throw new TypeError('Trial region and room limit are fixed');
  let origin;
  try { origin = new URL(value.previewOrigin); } catch { throw new TypeError('An exact HTTPS trial origin is required'); }
  const previewHost = new RegExp(`^${value.projectId}--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-z0-9]{4,20}\\.web\\.app$`);
  if (typeof value.previewOrigin !== 'string' || origin.origin !== value.previewOrigin || origin.protocol !== 'https:' || origin.port || origin.username || origin.password ||
      !(previewHost.test(origin.hostname) || (value.projectId === FIXED_TRIAL_PROJECT && value.previewOrigin === FIXED_TRIAL_ORIGIN)) || origin.hostname.split('.')[0].length > 63) throw new TypeError('Only an exact trial preview or the dedicated fixed Hosting origin is allowed');
  if (!Number.isSafeInteger(value.startsAtMillis) || !Number.isSafeInteger(value.endsAtMillis) || value.startsAtMillis <= 0 || value.endsAtMillis <= value.startsAtMillis || value.endsAtMillis - value.startsAtMillis > MAX_TRIAL_MILLIS) throw new TypeError('Trial needs a fixed positive window of at most seven days');
  return Object.freeze({ ...value });
}
function renderTrialRules(template, rawConfig) {
  const config = validateTrialConfig(rawConfig);
  const values = {
    __TRIAL_PROJECT_ID__: JSON.stringify(config.projectId),
    __TRIAL_PREVIEW_ORIGIN__: JSON.stringify(config.previewOrigin),
    __TRIAL_STARTS_AT_MILLIS__: String(config.startsAtMillis),
    __TRIAL_ENDS_AT_MILLIS__: String(config.endsAtMillis),
    __TRIAL_ENABLED__: String(config.enabled),
  };
  let result = template;
  for (const [token, value] of Object.entries(values)) {
    if (!result.includes(token)) throw new TypeError(`Missing rules template token: ${token}`);
    result = result.replaceAll(token, value);
  }
  if (/__TRIAL_[A-Z_]+__/.test(result)) throw new TypeError('Unresolved trial rules token');
  return result;
}
module.exports = { FIXED_TRIAL_PROJECT, FIXED_TRIAL_ORIGIN, REGION, MAX_ROOMS, MAX_TRIAL_MILLIS, FORBIDDEN_PROJECTS, CALLABLE_NAMES, validateTrialConfig, renderTrialRules };
