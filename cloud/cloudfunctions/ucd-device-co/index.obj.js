/**
 * ucd-device-co：设备登记与管理（配合 unicloud-sdk 的 options.device）。
 *
 * 依赖：公共模块 ucd-device-auth（必需）、uni-id-common（可选；没有时所有设备按游客登记）。
 * 在 HBuilderX 中右键本云对象 →「管理公共模块或扩展库依赖」勾选它们。
 */
const { createDeviceAuth, createUniCloudStore, protectCloudObject, createUniIdResolver } = require('ucd-device-auth');

let uniIdCommon = null;
try {
  uniIdCommon = require('uni-id-common');
} catch (e) {
  uniIdCommon = null;
}

const auth = createDeviceAuth({
  store: createUniCloudStore(uniCloud.database()),
  allowAnonymous: true,
  maxDevicesPerUser: 10,
});

function toResult(error) {
  if (error && error.errCode) {
    const out = { errCode: error.errCode, errMsg: error.errMsg || error.message, errSubject: 'ucd-device-auth' };
    if (typeof error.serverTime === 'number') out.serverTime = error.serverTime;
    return out;
  }
  throw error;
}

/** uni-id 校验：带了 token 就必须有效；没有 token 视为游客 */
const resolveUid = createUniIdResolver(uniIdCommon);

// 说明：所有错误都以普通结果返回（不在 _before 抛错），否则支付宝云会返回 HTTP 500、丢失 errCode。
const enrollMethods = {
  async beginEnroll(input) {
    try {
      const uid = await resolveUid(this);
      return { errCode: 0, ...(await auth.beginEnroll(input, { uid })) };
    } catch (e) {
      return toResult(e);
    }
  },

  async completeEnroll(input) {
    try {
      const uid = await resolveUid(this);
      return { errCode: 0, ...(await auth.completeEnroll(input, { uid })) };
    } catch (e) {
      return toResult(e);
    }
  },
};

// 管理接口：要求登录 + 本设备已登记且属于当前用户
const manageMethods = protectCloudObject(
  {
    async listMyDevices() {
      return { errCode: 0, current: this.device.deviceId, list: await auth.listDevices(this.uid) };
    },
    async revokeMyDevice({ deviceId } = {}) {
      try {
        return { errCode: 0, ...(await auth.revokeDevice(String(deviceId || ''), { uid: this.uid })) };
      } catch (e) {
        return toResult(e);
      }
    },
  },
  { auth, object: 'ucd-device-co', resolveUid, requireUserMethods: ['listMyDevices', 'revokeMyDevice'] },
);

module.exports = { ...enrollMethods, ...manageMethods };
