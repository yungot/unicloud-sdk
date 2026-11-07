/**
 * 云对象模板：由云端决定上传路径并下发短期上传凭证（扩展存储 / 七牛）。
 * 放到 uniCloud-alipay/cloudfunctions/file-co/index.obj.js，按需修改。
 * 必须添加扩展库依赖：右键云对象 →「管理公共模块或扩展库依赖」→ 勾选 uni-cloud-ext-storage。
 *
 * 安全要点：
 * - 上传路径由云端生成，客户端无法指定或覆盖别人的文件；
 * - 只给已登录用户下发，且按用户限流；
 * - 客户端拿到的 token 只对这一个 key 有效，很快过期。
 *
 * 客户端：
 *   const opts = await cloud.importObject('file-co').getAvatarUploadOptions({ ext: 'png' })
 *   await uploadWithOptions({ uploadFileOptions: opts.uploadFileOptions, file, fileName: 'avatar.png' })
 *   await cloud.importObject('file-co').confirmAvatar({ fileID: opts.fileID })
 */
const uniIdCommon = require('uni-id-common');

const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);

module.exports = {
  async _before() {
    // S3 之后：在这里先调用统一的设备签名校验模块
    const uniIdIns = uniIdCommon.createInstance({ clientInfo: this.getClientInfo() });
    const auth = await uniIdIns.checkToken(this.getUniIdToken());
    if (auth.errCode) throw { errCode: 'NEED_LOGIN', errMsg: '请先登录', errSubject: 'file-co' };
    this.uid = auth.uid;
  },

  async getAvatarUploadOptions({ ext } = {}) {
    const safeExt = String(ext || '').toLowerCase();
    if (!ALLOWED_EXT.has(safeExt)) return { errCode: 'INVALID_PARAM', errMsg: '不支持的文件类型' };
    // 路径完全由云端生成
    const cloudPath = `avatar/${this.uid}/${Date.now()}.${safeExt}`;
    const manager = uniCloud.getExtStorageManager({ provider: 'qiniu', domain: 'cdn.example.com' });
    const res = manager.getUploadFileOptions({ cloudPath, allowUpdate: false });
    return { errCode: 0, fileID: res.fileID, uploadFileOptions: res.uploadFileOptions };
  },
};
