'use strict';
/**
 * ucd-device-auth：桌面 / Web 客户端设备身份校验（云端公共模块）。
 *
 * 与 SDK src/device.ts 协议 v1 对应：
 *   登记：beginEnroll → completeEnroll（挑战-签名，证明持有私钥）
 *   请求：clientInfo.devicePoP = { v, kid, ts, nonce, sig }，在云对象 _before 里调用 verify。
 *
 * 只依赖 Node 内置 crypto；数据存取通过 store 接口（uniCloud 数据库实现见 createUniCloudStore）。
 */
const crypto = require('crypto');

const PROOF_PREFIX = 'UCDP1';
const ENROLL_PREFIX = 'UCDE1';
const ERR = {
  MISSING: 'DEVICE_PROOF_MISSING',
  MALFORMED: 'DEVICE_PROOF_MALFORMED',
  EXPIRED: 'DEVICE_PROOF_EXPIRED',
  INVALID: 'DEVICE_PROOF_INVALID',
  REPLAYED: 'DEVICE_PROOF_REPLAYED',
  NOT_ENROLLED: 'DEVICE_NOT_ENROLLED',
  REVOKED: 'DEVICE_REVOKED',
  USER_MISMATCH: 'DEVICE_USER_MISMATCH',
  NOT_BOUND: 'DEVICE_NOT_BOUND',
  ENROLL_INVALID: 'DEVICE_ENROLL_INVALID',
  ENROLL_EXPIRED: 'DEVICE_ENROLL_EXPIRED',
  LIMIT: 'DEVICE_LIMIT_EXCEEDED',
  LOGIN_REQUIRED: 'DEVICE_LOGIN_REQUIRED',
};

const B64URL = /^[A-Za-z0-9_-]+$/;

class DeviceAuthError extends Error {
  constructor(errCode, errMsg, extra) {
    super(errMsg);
    this.errCode = errCode;
    this.errMsg = errMsg;
    this.errSubject = 'ucd-device-auth';
    if (extra) Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- 与 SDK 一致的工具函数

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    const out = JSON.stringify(value);
    return out === undefined ? 'null' : out;
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
    .sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function thumbprint(jwk) {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function validateJwk(jwk) {
  return (
    jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' && typeof jwk.y === 'string' &&
    jwk.x.length === 43 && jwk.y.length === 43 && B64URL.test(jwk.x) && B64URL.test(jwk.y)
  );
}

function verifySignature(jwk, text, sig) {
  if (typeof sig !== 'string' || !B64URL.test(sig) || sig.length !== 86) return false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    return crypto.verify('sha256', Buffer.from(text, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  } catch (e) {
    return false;
  }
}

function proofText({ kid, target, method, ts, nonce, params, uniIdToken }) {
  return [PROOF_PREFIX, kid, target, method, String(ts), nonce, sha256Hex(canonicalJson(params)), sha256Hex(uniIdToken || '')].join('\n');
}

const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// ---------------------------------------------------------------- 存储

/** 内存存储：单元测试用；云端多实例下不可用于生产 */
function createMemoryStore() {
  const devices = new Map();
  const enrolls = new Map();
  const nonces = new Map();
  return {
    async getDevice(kid) { return devices.get(kid) || null; },
    async saveDevice(device) { devices.set(device.kid, { ...device }); },
    async updateDevice(kid, patch) { const d = devices.get(kid); if (d) devices.set(kid, { ...d, ...patch }); },
    async listDevicesByUid(uid) { return [...devices.values()].filter((d) => d.uid === uid); },
    async saveEnroll(enroll) { enrolls.set(enroll.enrollId, { ...enroll }); },
    async takeEnroll(enrollId) { const e = enrolls.get(enrollId) || null; enrolls.delete(enrollId); return e; },
    async useNonce(kid, nonce, expiresAt) {
      const id = `${kid}:${nonce}`;
      if (nonces.has(id)) return false;
      nonces.set(id, expiresAt);
      return true;
    },
    async purgeExpired(now) { for (const [id, exp] of nonces) if (exp < now) nonces.delete(id); },
  };
}

function isDuplicateError(e) {
  if (!e) return false;
  if (e.errCode === -409 || e.code === -409 || e.code === 11000) return true;
  return /duplicate|E11000|unique|already exist/i.test(String(e.errMsg || e.message || e));
}

/**
 * uniCloud 数据库存储。集合：ucd-device-keys / ucd-device-enrolls / ucd-device-nonces
 * （schema 见 cloud/database，权限全部为 false，只允许云端访问）。
 */
function createUniCloudStore(db, names = {}) {
  const C = {
    devices: names.devices || 'ucd-device-keys',
    enrolls: names.enrolls || 'ucd-device-enrolls',
    nonces: names.nonces || 'ucd-device-nonces',
  };
  const dbCmd = db.command;
  return {
    async getDevice(kid) {
      const res = await db.collection(C.devices).where({ kid }).limit(1).get();
      return (res.data && res.data[0]) || null;
    },
    async saveDevice(device) {
      const res = await db.collection(C.devices).where({ kid: device.kid }).update(device);
      if (!res.updated) await db.collection(C.devices).add(device);
    },
    async updateDevice(kid, patch) {
      await db.collection(C.devices).where({ kid }).update(patch);
    },
    async listDevicesByUid(uid) {
      const res = await db.collection(C.devices).where({ uid }).limit(100).get();
      return res.data || [];
    },
    async saveEnroll(enroll) {
      await db.collection(C.enrolls).add(enroll);
    },
    async takeEnroll(enrollId) {
      // 先原子地把 used 从 false 改为 true，只有成功的一方能拿到记录（一次性）
      const upd = await db.collection(C.enrolls).where({ enrollId, used: false }).update({ used: true });
      if (!upd.updated) return null;
      const res = await db.collection(C.enrolls).where({ enrollId }).limit(1).get();
      return (res.data && res.data[0]) || null;
    },
    async useNonce(kid, nonce, expiresAt) {
      const nonceKey = `${kid}:${nonce}`;
      try {
        await db.collection(C.nonces).add({ nonceKey, kid, expiresAt });
      } catch (e) {
        // 有 nonceKey 唯一索引时，重复插入直接失败。
        // 支付宝云返回 { errCode: -409, errMsg: 'document is already exists' }（S3 实测）；兼容 MongoDB 的 E11000。
        if (isDuplicateError(e)) return false;
        throw e;
      }
      // 没有唯一索引时的兜底：插入后计数，出现多条即视为重放（并发时双方都拒绝，宁可失败也不放行）
      const res = await db.collection(C.nonces).where({ nonceKey }).count();
      return res.total === 1;
    },
    async purgeExpired(now) {
      await db.collection(C.nonces).where({ expiresAt: dbCmd.lt(now) }).remove();
      await db.collection(C.enrolls).where({ expiresAt: dbCmd.lt(now) }).remove();
    },
  };
}

// ---------------------------------------------------------------- 主体

/**
 * @param {object} options
 * @param {object} options.store                 createUniCloudStore(uniCloud.database()) 或自定义
 * @param {number} [options.windowMs=120000]     时间窗口（± 毫秒）
 * @param {number} [options.enrollTtlMs=300000]  登记挑战有效期
 * @param {number} [options.maxDevicesPerUser=10]
 * @param {boolean} [options.allowAnonymous=true] 允许未登录设备登记（游客模式）
 * @param {number} [options.cacheMs=30000]       设备记录缓存（吊销最长延迟）
 * @param {() => number} [options.now]
 */
function createDeviceAuth(options) {
  const store = options.store;
  if (!store) throw new Error('ucd-device-auth: store is required');
  const windowMs = options.windowMs || 120000;
  const enrollTtlMs = options.enrollTtlMs || 300000;
  const maxDevicesPerUser = options.maxDevicesPerUser || 10;
  const allowAnonymous = options.allowAnonymous !== false;
  const cacheMs = options.cacheMs === undefined ? 30000 : options.cacheMs;
  const now = options.now || Date.now;
  const cache = new Map();

  async function loadDevice(kid) {
    const hit = cache.get(kid);
    if (hit && hit.until > now()) return hit.device;
    const device = await store.getDevice(kid);
    if (device && cacheMs > 0) cache.set(kid, { device, until: now() + cacheMs });
    return device;
  }

  async function maybePurge() {
    if (Math.random() < 0.01) await store.purgeExpired(now()).catch(() => {});
  }

  return {
    ERR,

    /**
     * 登记第 1 步。uid 为当前登录用户（未登录传 null）。
     * @returns {{ enrollId, challenge, kid, serverTime, expiresAt }}
     */
    async beginEnroll(input, { uid = null } = {}) {
      const jwk = input && input.publicJwk;
      if (!validateJwk(jwk)) throw new DeviceAuthError(ERR.ENROLL_INVALID, '设备公钥不合法');
      if (!uid && !allowAnonymous) throw new DeviceAuthError(ERR.LOGIN_REQUIRED, '登记设备前请先登录');
      const kid = thumbprint(jwk);
      const enrollId = randomId(18);
      const challenge = randomId(32);
      const expiresAt = now() + enrollTtlMs;
      await store.saveEnroll({
        enrollId, kid, challenge, uid, expiresAt, used: false,
        publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
        platform: String(input.platform || '').slice(0, 32),
        deviceName: String(input.deviceName || '').slice(0, 64),
        // 客户端自报的保护等级，仅记录，不作为信任依据
        claimedAssurance: String(input.assurance || '').slice(0, 32),
        createdAt: now(),
      });
      await maybePurge();
      return { enrollId, challenge, kid, serverTime: now(), expiresAt };
    },

    /**
     * 登记第 2 步：校验对挑战的签名，写入设备记录。
     * @returns {{ deviceId, uid, serverTime }}
     */
    async completeEnroll(input, { uid = null } = {}) {
      const enrollId = input && input.enrollId;
      if (typeof enrollId !== 'string' || !B64URL.test(enrollId)) throw new DeviceAuthError(ERR.ENROLL_INVALID, '登记请求不合法');
      const enroll = await store.takeEnroll(enrollId);
      if (!enroll) throw new DeviceAuthError(ERR.ENROLL_INVALID, '登记请求不存在或已使用');
      if (enroll.expiresAt < now()) throw new DeviceAuthError(ERR.ENROLL_EXPIRED, '登记已过期，请重试');
      if ((enroll.uid || null) !== (uid || null)) throw new DeviceAuthError(ERR.ENROLL_INVALID, '登录状态在登记过程中发生变化');
      const text = [ENROLL_PREFIX, enroll.enrollId, enroll.kid, enroll.challenge].join('\n');
      if (!verifySignature(enroll.publicJwk, text, input.signature)) {
        throw new DeviceAuthError(ERR.INVALID, '设备签名校验失败');
      }

      const existing = await store.getDevice(enroll.kid);
      if (existing && existing.status === 'revoked') throw new DeviceAuthError(ERR.REVOKED, '该设备已被停用');
      if (existing && existing.uid && uid && existing.uid !== uid) {
        throw new DeviceAuthError(ERR.USER_MISMATCH, '该设备已绑定其他账号');
      }
      const boundUid = (existing && existing.uid) || uid || null;
      if (uid && !(existing && existing.uid === uid)) {
        const active = (await store.listDevicesByUid(uid)).filter((d) => d.status === 'active');
        if (active.length >= maxDevicesPerUser) throw new DeviceAuthError(ERR.LIMIT, `每个账号最多 ${maxDevicesPerUser} 台设备`);
      }
      const record = {
        kid: enroll.kid,
        publicJwk: enroll.publicJwk,
        uid: boundUid,
        status: 'active',
        platform: enroll.platform,
        deviceName: enroll.deviceName,
        claimedAssurance: enroll.claimedAssurance,
        createdAt: (existing && existing.createdAt) || now(),
        updatedAt: now(),
        lastSeenAt: now(),
      };
      await store.saveDevice(record);
      cache.delete(enroll.kid);
      return { deviceId: enroll.kid, uid: boundUid, serverTime: now() };
    },

    /**
     * 校验一次请求的设备证明。失败抛 DeviceAuthError（带 errCode，过期时带 serverTime）。
     *
     * @param {object} req
     * @param {string} req.target       云对象 / 云函数名
     * @param {string} req.method       云对象方法名（云函数传 ''）
     * @param {*}      req.params       云对象为参数数组；云函数为 event 去掉 clientInfo、uniIdToken
     * @param {object} req.clientInfo   this.getClientInfo() / event.clientInfo
     * @param {string} [req.uniIdToken] this.getUniIdToken() / event.uniIdToken
     * @param {object} [policy]
     * @param {boolean} [policy.replay='nonce']  'nonce'：一次性（写操作必须）；'window'：只校验时间窗（只读高频接口）
     * @param {string|null} [policy.uid]         已通过 uni-id checkToken 的用户 ID：要求设备绑定该用户
     * @param {boolean} [policy.requireUser=false] 要求已登录（policy.uid 必须有值）
     * @returns {{ deviceId, uid, platform, claimedAssurance }}
     */
    async verify(req, policy = {}) {
      const pop = req.clientInfo && req.clientInfo.devicePoP;
      if (!pop) throw new DeviceAuthError(ERR.MISSING, '缺少设备证明');
      const { v, kid, ts, nonce, sig } = pop;
      if (v !== 1 || typeof kid !== 'string' || kid.length !== 43 || !B64URL.test(kid) ||
          typeof ts !== 'number' || !Number.isFinite(ts) ||
          typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 64 || !B64URL.test(nonce)) {
        throw new DeviceAuthError(ERR.MALFORMED, '设备证明格式不合法');
      }
      const current = now();
      if (Math.abs(current - ts) > windowMs) {
        throw new DeviceAuthError(ERR.EXPIRED, '设备证明已过期，请校准时间', { serverTime: current });
      }
      const device = await loadDevice(kid);
      if (!device) throw new DeviceAuthError(ERR.NOT_ENROLLED, '设备未登记');
      if (device.status !== 'active') throw new DeviceAuthError(ERR.REVOKED, '该设备已被停用');

      const text = proofText({
        kid, target: String(req.target), method: String(req.method || ''), ts, nonce,
        params: req.params, uniIdToken: req.uniIdToken,
      });
      if (!verifySignature(device.publicJwk, text, sig)) throw new DeviceAuthError(ERR.INVALID, '设备签名校验失败');

      if ((policy.replay || 'nonce') === 'nonce') {
        const fresh = await store.useNonce(kid, nonce, ts + windowMs);
        if (!fresh) throw new DeviceAuthError(ERR.REPLAYED, '请求重复');
        await maybePurge();
      }
      // 已登录请求：设备必须绑定到同一用户。
      // 未绑定（游客期登记的设备）→ NOT_BOUND，SDK 会自动重新登记完成绑定；绑定到别人 → USER_MISMATCH。
      const uid = policy.uid || null;
      if (uid) {
        if (!device.uid) throw new DeviceAuthError(ERR.NOT_BOUND, '设备尚未绑定当前账号');
        if (device.uid !== uid) throw new DeviceAuthError(ERR.USER_MISMATCH, '设备与当前账号不匹配');
      } else if (policy.requireUser) {
        throw new DeviceAuthError(ERR.LOGIN_REQUIRED, '请先登录');
      }
      if (!device.lastSeenAt || current - device.lastSeenAt > 3600000) {
        store.updateDevice(kid, { lastSeenAt: current }).catch(() => {});
      }
      return { deviceId: kid, uid: device.uid || null, platform: device.platform, claimedAssurance: device.claimedAssurance };
    },

    /** 用户查看自己的设备 */
    async listDevices(uid) {
      const list = await store.listDevicesByUid(uid);
      return list.map((d) => ({
        deviceId: d.kid, deviceName: d.deviceName, platform: d.platform, status: d.status,
        createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
      }));
    },

    /** 吊销设备（用户只能吊销自己的；管理员传 uid=null 且 asAdmin=true） */
    async revokeDevice(deviceId, { uid = null, asAdmin = false } = {}) {
      const device = await store.getDevice(deviceId);
      if (!device) throw new DeviceAuthError(ERR.NOT_ENROLLED, '设备不存在');
      if (!asAdmin && device.uid !== uid) throw new DeviceAuthError(ERR.USER_MISMATCH, '无权操作该设备');
      await store.updateDevice(deviceId, { status: 'revoked', updatedAt: now() });
      cache.delete(deviceId);
      return { deviceId, status: 'revoked' };
    },
  };
}

/**
 * 校验当前云对象请求（底层函数；业务云对象请优先用 protectCloudObject）：
 *   const auth = createDeviceAuth({ store: createUniCloudStore(uniCloud.database()) })
 *   async _before() { this.device = await guardCloudObject(this, auth, { object: 'music', readMethods: ['search'] }) }
 */
async function guardCloudObject(ctx, auth, { object, readMethods = [], uid, requireUser = false } = {}) {
  const method = ctx.getMethodName();
  return auth.verify(
    {
      target: object,
      method,
      params: ctx.getParams(),
      clientInfo: ctx.getClientInfo(),
      uniIdToken: ctx.getUniIdToken(),
    },
    {
      replay: readMethods.includes(method) ? 'window' : 'nonce',
      ...(uid !== undefined ? { uid } : {}),
      requireUser,
    },
  );
}

/** 把带 errCode 的错误转成普通返回值（HTTP 200），客户端才能拿到错误码 */
function errorToResult(error) {
  const out = { errCode: error.errCode, errMsg: error.errMsg || error.message || 'error' };
  if (error.errSubject) out.errSubject = error.errSubject;
  if (typeof error.serverTime === 'number') out.serverTime = error.serverTime;
  return out;
}

/**
 * 用设备门禁包装云对象的每个公开方法（推荐，替代在 _before 里抛错）。
 *
 * 原因：支付宝云上 _before 抛出的错误会变成 HTTP 500「用户函数代码语法或逻辑异常」，
 * errCode 丢失，SDK 无法据此自动登记 / 校准时钟。这里在方法内部校验，失败时以普通结果返回错误码。
 *
 *   module.exports = protectCloudObject({
 *     async search(keyword) { ... this.device / this.uid 可用 ... },
 *   }, {
 *     auth, object: 'music', readMethods: ['search'],
 *     resolveUid: async (ctx) => uid | null,   // 可选：uni-id 校验，抛带 errCode 的错误同样会转成结果
 *     publicMethods: ['diag'],                 // 可选：不校验设备的方法
 *   })
 */
function protectCloudObject(definition, options) {
  const { auth, object, readMethods = [], publicMethods = [], resolveUid, requireUserMethods = [] } = options || {};
  if (!auth || !object) throw new Error('protectCloudObject: auth and object are required');
  const wrapped = {};
  for (const [name, value] of Object.entries(definition)) {
    if (typeof value !== 'function' || name.startsWith('_') || publicMethods.includes(name)) {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async function guarded(...args) {
      try {
        this.uid = resolveUid ? (await resolveUid(this)) || null : null;
        this.device = await guardCloudObject(this, auth, {
          object,
          readMethods,
          uid: this.uid,
          requireUser: requireUserMethods.includes(name),
        });
      } catch (error) {
        if (error && error.errCode) return errorToResult(error);
        throw error;
      }
      return value.apply(this, args);
    };
  }
  return wrapped;
}

/**
 * 用 uni-id-common 校验登录 token，返回 uid（未带 token 返回 null）。
 * token 无效时抛出带 errCode 的错误，配合 protectCloudObject 会以普通结果返回给客户端。
 *
 *   const resolveUid = createUniIdResolver(require('uni-id-common'))
 *   module.exports = protectCloudObject({...}, { auth, object: 'music', resolveUid })
 *
 * 未实测（需服务空间已配置 uni-id）。
 */
function createUniIdResolver(uniIdCommon) {
  return async function resolveUid(ctx) {
    const token = ctx.getUniIdToken();
    if (!token) return null;
    if (!uniIdCommon) throw { errCode: 'UNI_ID_UNAVAILABLE', errMsg: '服务端未配置 uni-id' };
    const res = await uniIdCommon.createInstance({ clientInfo: ctx.getClientInfo() }).checkToken(token);
    if (res.errCode) throw { errCode: res.errCode, errMsg: res.errMsg || 'token 无效', errSubject: 'uni-id' };
    return res.uid;
  };
}

module.exports = {
  createDeviceAuth,
  createUniIdResolver,
  protectCloudObject,
  errorToResult,
  createMemoryStore,
  createUniCloudStore,
  guardCloudObject,
  canonicalJson,
  thumbprint,
  isDuplicateError,
  DeviceAuthError,
  ERR,
};
