/**
 * 示例：把 SDK 接到应用自定义的业务 Provider 契约上。
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

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  cover?: string;
  src?: string;
}

export interface MusicProvider {
  listTracks(folder?: string): Promise<Track[]>;
  search?(keyword: string): Promise<Track[]>;
  resolvePlayable(track: Track): Promise<string>;
  getLyric?(track: Track): Promise<string>;
}

interface MusicApi {
  search(keyword: string, page?: number): Promise<{ list: Track[] }>;
  getPlayUrl(id: string): Promise<{ url: string }>;
  getLyric(id: string): Promise<{ lrc: string }>;
  listPlaylist(id?: string): Promise<{ list: Track[] }>;
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

/** 用同一个 SDK 实现业务 Provider，上层业务代码无需改动 */
export class UniCloudMusicProvider implements MusicProvider {
  private readonly api: MusicApi;

  constructor(cloud: UniCloudDesktopClient) {
    this.api = cloud.importObject<MusicApi>('music');
  }

  async listTracks(): Promise<Track[]> {
    return (await this.api.listPlaylist()).list;
  }

  async search(keyword: string): Promise<Track[]> {
    return (await this.api.search(keyword)).list;
  }

  async resolvePlayable(track: Track): Promise<string> {
    if (track.src) return track.src;
    return (await this.api.getPlayUrl(track.id)).url;
  }

  async getLyric(track: Track): Promise<string> {
    return (await this.api.getLyric(track.id)).lrc;
  }
}

/** 云端对应云对象（放到 uniCloud-alipay/cloudfunctions/music/index.obj.js） */
export const CLOUD_OBJECT_SNIPPET = `
module.exports = {
  async _before() {
    const info = this.getClientInfo()
    if (info.source !== 'client') throw new Error('client sdk required')
    if (info.appId !== '__UNI__YOUR_APP') throw new Error('unknown app')
  },
  async search(keyword, page = 1) {
    const db = uniCloud.database()
    const res = await db.collection('songs')
      .where({ title: new RegExp(keyword, 'i') })
      .skip((page - 1) * 20).limit(20).get()
    return { list: res.data }
  },
  async getPlayUrl(id) { /* 返回云存储临时直链 */ },
  async getLyric(id) { /* 返回 LRC */ },
  async listPlaylist() { /* ... */ }
}
`;
