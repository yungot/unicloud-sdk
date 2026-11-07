/**
 * S3 临时测试云对象：验证设备门禁在真实 uniCloud 上的行为。测试完成后请删除。
 * 依赖：公共模块 ucd-device-auth（右键 →「管理公共模块或扩展库依赖」勾选）。
 */
const { createDeviceAuth, createUniCloudStore, protectCloudObject } = require('ucd-device-auth');

const auth = createDeviceAuth({ store: createUniCloudStore(uniCloud.database()) });

module.exports = protectCloudObject(
  {
    /** 不校验：确认 clientInfo.devicePoP 与 getParams() 能到达云端 */
    diag(...args) {
      const info = this.getClientInfo();
      const pop = info.devicePoP;
      return {
        errCode: 0,
        hasDevicePoP: Boolean(pop),
        popKeys: pop ? Object.keys(pop).sort() : [],
        paramsIsArray: Array.isArray(this.getParams()),
        paramsEqualsArgs: JSON.stringify(this.getParams()) === JSON.stringify(args),
        hasUniIdToken: Boolean(this.getUniIdToken()),
      };
    },

    ping(x) {
      return { errCode: 0, method: 'ping', deviceId: this.device.deviceId, echo: x };
    },

    write(x) {
      return { errCode: 0, method: 'write', deviceId: this.device.deviceId, echo: x };
    },
  },
  { auth, object: 's3-guard-probe', readMethods: ['ping'], publicMethods: ['diag'] },
);
