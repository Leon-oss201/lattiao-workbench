#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云端版每日备份 —— backup_cloud.py（跑在 GitHub Actions 上）

与本机版 data_snapshot.py 的区别：
  - 本机版：拉数据 → 存本地 backups/（给人看），不动云端
  - **云端版（本文件）**：
      1. 拉 Gitee 上的 data/trips.json（只读）
      2. 把快照写回 Gitee 的 **backups/YYYY-MM-DD/**（云端留档，回滚用）
      3. 清理 backups/ 与 data/backup/ 里超过 N 天的
      4. **写一份「备份报告」到 data/backup-report.json**
         → App 启动时读它，发现有新报告就在**通知中心**给用户一条反馈

安全红线：
  - **绝不写 data/trips.json**（那是用户的正式数据）—— 只写 data/backup-report.json 和 backups/
  - 报告里只放日期/条数/耗时这类元信息，不含任何行程内容
"""
import os, sys, json, io, time, base64, hashlib, shutil, datetime, urllib.request, urllib.parse, urllib.error

# 上海时区（UTC+8，无夏令时）。GitHub Actions runner 是 UTC，必须用上海时区算"日期"，
# 否则北京时间凌晨跑的备份会被归到 UTC 的前一天（曾导致 backups/ 目录与通知日期错位）。
SHANGHAI = datetime.timezone(datetime.timedelta(hours=8))

REPO = os.environ.get('GITEE_REPO', 'zyl_Leon/lattiao-workbench')
BRANCH = os.environ.get('GITEE_BRANCH', 'master')
TOKEN = (os.environ.get('GITEE_TOKEN') or '').strip()
KEEP = int(os.environ.get('KEEP_DAYS') or '7')
API = 'https://gitee.com/api/v5/repos/' + REPO
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '_snapshot_out')

H = {'Authorization': 'token ' + TOKEN, 'User-Agent': 'lattiao-nightly-backup',
     'Content-Type': 'application/json; charset=utf-8'}


def log(m):
    print('[backup] ' + m, flush=True)


def api_get(path, query=''):
    url = API + path + (('?' + query) if query else '')
    return urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60).read()


def api_json(path, query=''):
    return json.loads(api_get(path, query).decode('utf-8'))


def api_post(path, payload, query='', method='POST'):
    url = API + path + (('?' + query) if query else '')
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'),
                                 headers=H, method=method)
    return urllib.request.urlopen(req, timeout=60).read()


def api_delete(path, sha):
    q = urllib.parse.urlencode({'ref': BRANCH, 'sha': sha,
                               'message': 'nightly backup: prune expired snapshot'})
    url = API + path + '?' + q
    req = urllib.request.Request(url, headers=H, method='DELETE')
    return urllib.request.urlopen(req, timeout=60).read()


def get_file(rel):
    """读一个云端文件的内容（bytes）。不存在返回 None。"""
    try:
        j = json.loads(api_get('/contents/' + rel, 'ref=' + BRANCH).decode('utf-8'))
        if isinstance(j, list):
            return None
        return base64.b64decode(j.get('content') or '')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def put_file(rel, blob, message):
    """写一个云端文件（不存在则创建，存在则更新）。"""
    body = base64.b64encode(blob).decode('ascii')
    sha = None
    try:
        j = json.loads(api_get('/contents/' + rel, 'ref=' + BRANCH).decode('utf-8'))
        if not isinstance(j, list):
            sha = j.get('sha')
    except urllib.error.HTTPError:
        pass
    except Exception:
        pass
    payload = {'message': message, 'content': body, 'branch': BRANCH}
    if sha:
        payload['sha'] = sha
    # Gitee 的 Contents API：**新建用 POST，更新用 PUT**（用 POST 更新会报
    # "文件名已存在" 400）。分支**只放 body**，query 里再带 ref= 会与 body 冲突。
    api_post('/contents/' + rel, payload, query='', method=('PUT' if sha else 'POST'))
    return True


def list_dir(rel):
    try:
        j = api_json('/contents/' + rel, 'ref=' + BRANCH)
        return j if isinstance(j, list) else []
    except urllib.error.HTTPError:
        return []


def prune_dir(rel, keep, only_date_json=True, also_dirs=False):
    """删掉目录里超过保留期的文件（also_dirs=True 时连日期子目录一起删）。"""
    items = list_dir(rel)
    snaps = []
    dirs = []
    for it in items:
        if it.get('type') == 'dir':
            dirs.append(it)
            continue
        if it.get('type') != 'file':
            continue
        if only_date_json and not it['name'][:2].isdigit():
            continue
        snaps.append(it)
    snaps.sort(key=lambda x: x['name'], reverse=True)
    removed = 0
    for it in snaps[keep:]:
        try:
            api_delete('/contents/' + rel + '/' + it['name'], it.get('sha') or '')
            log('清理过期 %s/%s' % (rel, it['name']))
            removed += 1
        except Exception as e:
            log('清理失败 %s/%s：%s' % (rel, it['name'], str(e)[:60]))
    # 日期子目录（backups/YYYY-MM-DD/）也要清，否则目录会无限累积
    dcount = 0
    if also_dirs:
        dd = [d for d in dirs if d['name'][:2].isdigit()]
        dd.sort(key=lambda x: x['name'], reverse=True)
        for d in dd[keep:]:
            try:
                # 先删目录里的文件
                for f in list_dir(rel + '/' + d['name']):
                    if f.get('type') == 'file':
                        api_delete('/contents/%s/%s/%s' % (rel, d['name'], f['name']), f.get('sha') or '')
                api_delete('/contents/' + rel + '/' + d['name'], d.get('sha') or '')
                log('清理过期目录 %s/%s/' % (rel, d['name']))
                dcount += 1
            except Exception as e:
                log('清理目录失败 %s/%s：%s' % (rel, d['name'], str(e)[:60]))
    return removed + dcount, len(snaps)


def main():
    t0 = time.time()
    if not TOKEN:
        print('!! 没有 GITEE_TOKEN，退出'); sys.exit(2)
    log('仓库 %s 分支 %s 保留 %d 天' % (REPO, BRANCH, KEEP))
    stamp = datetime.datetime.now(SHANGHAI).date().isoformat()

    # ① 读正式数据（只读）
    raw = get_file('data/trips.json')
    if raw is None:
        print('!! 读不到 data/trips.json，退出'); sys.exit(3)
    digest = hashlib.sha256(raw).hexdigest()[:16]
    try:
        d = json.loads(raw.decode('utf-8'))
    except Exception:
        d = {}
    stats = {
        'trips': len(d.get('trips') or []),
        'joys': len(d.get('joys') or []),
        'guides': len(d.get('guides') or []),
        'favorites': len(d.get('favorites') or []),
        'notifs': len(d.get('notifs') or []),
        'bytes': len(raw),
    }
    log('正式数据：%d 行程 / %d 小确幸 / %d 攻略（%d 字节, sha %s）'
        % (stats['trips'], stats['joys'], stats['guides'], stats['bytes'], digest))

    # ② 快照存到云端 backups/<日期>/
    os.makedirs(os.path.join(OUT, stamp), exist_ok=True)
    with open(os.path.join(OUT, stamp, 'trips.json'), 'wb') as f:
        f.write(raw)
    # 照片分片清单
    try:
        photos = list_dir('data/photos')
        names = sorted([i['name'] for i in photos if i.get('type') == 'dir'])
        with open(os.path.join(OUT, stamp, 'photos_index.json'), 'w', encoding='utf-8') as f:
            json.dump({'trips': names}, f, ensure_ascii=False, indent=1)
        stats['photoTrips'] = len(names)
    except Exception as e:
        log('照片清单读取失败：%s' % str(e)[:50])

    # 上传快照到云端 backups/
    snap_rel = 'backups/' + stamp
    try:
        put_file(snap_rel + '/trips.json', raw, 'nightly backup: snapshot ' + stamp)
        idx = json.dumps({'date': stamp, 'stats': stats, 'sha': digest},
                         ensure_ascii=False, indent=1).encode('utf-8')
        put_file(snap_rel + '/manifest.json', idx, 'nightly backup: manifest ' + stamp)
        log('快照已存到云端 %s/' % snap_rel)
    except Exception as e:
        log('!! 快照上传失败：%s' % str(e)[:80])

    # ③ 清理过期（云端 backups/ 和 App 内置的 data/backup/）
    # 清理失败绝不能让整个备份失败（报告还没写！）—— 逐项 try
    n1 = c1 = n2 = c2 = 0
    try:
        n1, c1 = prune_dir('backups', KEEP, only_date_json=False, also_dirs=True)
    except Exception as e:
        log('!! 清理 backups/ 失败（不影响本次备份）：%s' % str(e)[:70])
    try:
        n2, c2 = prune_dir('data/backup', KEEP, only_date_json=True)
    except Exception as e:
        log('!! 清理 data/backup/ 失败（不影响本次备份）：%s' % str(e)[:70])
    log('清理：backups/ 删 %d（现存 %d）；data/backup/ 删 %d（现存 %d）' % (n1, c1, n2, c2))

    # ④ 写备份报告（App 读它来生成通知）
    report = {
        'date': stamp,
        'at': datetime.datetime.now(SHANGHAI).isoformat(timespec='seconds'),
        'ok': True,
        'sha': digest,
        'stats': stats,
        'kept': KEEP,
        'pruned': {'backups': n1, 'dataBackup': n2},
        'durationSec': round(time.time() - t0, 1),
        'ok_msg': '云端快照已保存（%d 行程 · %d 小确幸），保留 %d 天' % (
            stats['trips'], stats['joys'], KEEP),
    }
    try:
        put_file('data/backup-report.json',
                 json.dumps(report, ensure_ascii=False, indent=1).encode('utf-8'),
                 'nightly backup: report ' + stamp)
    except Exception as e:
        log('!! 报告写入失败：%s' % str(e)[:70])
        sys.exit(4)
    log('报告已写 data/backup-report.json')
    log('完成，用时 %.1fs' % (time.time() - t0))


if __name__ == '__main__':
    main()
