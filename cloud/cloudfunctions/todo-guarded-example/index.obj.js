/**
 * 业务云对象接入设备门禁的示例（复制到你的云对象，按需修改）。
 *
 * - 所有方法都要求设备证明（防脚本直接调用、防重放、可按设备吊销）；
 * - 只读高频方法（readMethods）只校验时间窗，省一次数据库写；写方法强制一次性 nonce；
 * - 已登录时要求设备绑定到同一用户；requireUserMethods 中的方法必须登录。
 *
 * 不要在 _before 里抛错做校验：支付宝云会把它变成 HTTP 500，客户端拿不到 errCode。
 */
const { createDeviceAuth, createUniCloudStore, protectCloudObject, createUniIdResolver } = require('ucd-device-auth');
const uniIdCommon = require('uni-id-common');

const auth = createDeviceAuth({ store: createUniCloudStore(uniCloud.database()) });

const resolveUid = createUniIdResolver(uniIdCommon);

module.exports = protectCloudObject(
  {
    async list() {
      return { errCode: 0, deviceId: this.device.deviceId, list: [] };
    },
    async add(title, content) {
      return { errCode: 0, uid: this.uid, title, content };
    },
  },
  {
    auth,
    object: 'todo-guarded-example', // 必须与客户端 importObject 的名字一致
    readMethods: ['list'],
    requireUserMethods: ['add'],
    resolveUid,
  },
);
