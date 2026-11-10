/**
 * 示例：把 SDK 接到应用自定义的业务接口上（以官方 todo 示例为例）。
 *
 * 这里只是「一个业务接入」的例子 —— SDK 本身与业务领域无关，
 * 任何云对象都可以用同一套 client 调用：
 *
 *   const billing = cloud.importObject('billing')
 *   await billing.createInvoice({ orderId })
 *
 * 实际项目里把下面的本地类型换成你自己领域中的类型定义。
 */
import { createClient, type UniCloudDesktopClient } from '../dist/index.js';

export interface Todo {
  _id: string;
  title: string;
  content: string;
  done?: boolean;
}

/** 上层业务代码依赖的接口：与数据来自哪里无关 */
export interface TodoProvider {
  list(): Promise<Todo[]>;
  add(title: string, content: string): Promise<string>;
  complete(id: string): Promise<void>;
}

/** 云对象 todo 的方法签名 */
interface TodoApi {
  list(): Promise<{ list: Todo[] }>;
  add(title: string, content: string): Promise<{ id: string }>;
  complete(id: string): Promise<{ updated: number }>;
}

export function createCloud(spaceId: string): UniCloudDesktopClient {
  return createClient({
    space: {
      provider: 'alipay',
      spaceId,
      spaceAppId: process.env.UNICLOUD_SPACE_APP_ID,
      accessKey: process.env.UNICLOUD_ACCESS_KEY,
      secretKey: process.env.UNICLOUD_SECRET_KEY,
    },
    appId: '__UNI__YOUR_APP',
    osName: 'windows',
    appVersion: '1.0.0',
  });
}

/** 用同一个 SDK 实现业务接口，上层业务代码无需改动 */
export class UniCloudTodoProvider implements TodoProvider {
  private readonly api: TodoApi;

  constructor(cloud: UniCloudDesktopClient) {
    this.api = cloud.importObject<TodoApi>('todo');
  }

  async list(): Promise<Todo[]> {
    return (await this.api.list()).list;
  }

  async add(title: string, content: string): Promise<string> {
    return (await this.api.add(title, content)).id;
  }

  async complete(id: string): Promise<void> {
    await this.api.complete(id);
  }
}

/** 云端对应云对象（放到 uniCloud-alipay/cloudfunctions/todo/index.obj.js） */
export const CLOUD_OBJECT_SNIPPET = `
const db = uniCloud.database()
module.exports = {
  async list() {
    const res = await db.collection('todo').orderBy('createdAt', 'desc').limit(100).get()
    return { list: res.data }
  },
  async add(title, content) {
    const res = await db.collection('todo').add({ title, content, done: false, createdAt: Date.now() })
    return { id: res.id }
  },
  async complete(id) {
    const res = await db.collection('todo').doc(id).update({ done: true })
    return { updated: res.updated }
  }
}
`;
