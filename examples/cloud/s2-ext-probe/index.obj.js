/**
 * S2 临时测试云对象：验证扩展存储（七牛）上传全流程。
 *
 * ⚠️ 仅用于 S2 验证，没有登录校验，测试完成后请立即从服务空间删除。
 *    为降低风险：只能操作 s2-test/ 前缀，每次路径由云端随机生成。
 *
 * 部署：复制到 uniCloud-alipay/cloudfunctions/s2-ext-probe/index.obj.js，
 *      把 DOMAIN 改成你在扩展存储里绑定的域名；
 *      右键云对象 →「管理公共模块或扩展库依赖」→ 勾选 uni-cloud-ext-storage（或使用同目录的 package.json）；
 *      然后右键上传部署。
 */
const DOMAIN = 'cdn.example.com'; // ← 改成你的扩展存储域名（不带 https://）
const PREFIX = 's2-test/';

function manager() {
  return uniCloud.getExtStorageManager({ provider: 'qiniu', domain: DOMAIN });
}

function assertTestFile(fileID) {
  const value = String(fileID || '');
  if (!value.includes(PREFIX)) throw new Error('only s2-test/ files are allowed');
  return value;
}

module.exports = {
  /** 生成一次性上传参数：路径由云端决定 */
  getUploadOptions() {
    const cloudPath = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
    const res = manager().getUploadFileOptions({ cloudPath, allowUpdate: false });
    return {
      errCode: 0,
      cloudPath: res.cloudPath,
      fileID: res.fileID,
      fileURL: res.fileURL,
      uploadFileOptions: res.uploadFileOptions,
    };
  },

  /** 获取临时下载链接（私有文件需要；公开文件也可用） */
  async getTempURL({ fileID } = {}) {
    const id = assertTestFile(fileID);
    const res = await manager().getTempFileURL({ fileList: [id] });
    return { errCode: 0, fileList: res.fileList };
  },

  /** 测试完清理 */
  async remove({ fileID } = {}) {
    const id = assertTestFile(fileID);
    const res = await manager().deleteFile({ fileList: [id] });
    return { errCode: 0, fileList: res.fileList };
  },
};
