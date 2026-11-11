#!/usr/bin/env python3
# Commits the regenerated files to the repo via the GitHub Contents API
# (avoids the "Argument list too long" limit of gh -f for ~150KB JSON payloads).
import base64
import json
import os
import urllib.request

TOKEN = os.environ['GH_TOKEN']
REPO = os.environ['GH_REPOSITORY']
BRANCH = 'main'

FILES = [
    ('list_v2.json', 'upstream_list.json'),
    ('list_v2_combined.json', 'list_v2_combined.json'),
    ('README.md', 'README.md'),
]


def api(path, body=None, method='GET'):
    req = urllib.request.Request('https://api.github.com' + path, method=method)
    req.add_header('Authorization', 'token ' + TOKEN)
    req.add_header('User-Agent', 'fckbot')
    req.add_header('Accept', 'application/vnd.github+json')
    if body is not None:
        req.add_header('Content-Type', 'application/json')
        req.data = json.dumps(body).encode('utf-8')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode('utf-8') or '{}')


def put_file(repo_path, local_file, message):
    with open(local_file, 'rb') as f:
        content = base64.b64encode(f.read()).decode('ascii')
    sha = None
    try:
        sha = api('/repos/%s/contents/%s?ref=%s' % (REPO, repo_path, BRANCH)).get('sha')
    except Exception:
        pass
    body = {'message': message, 'content': content, 'branch': BRANCH}
    if sha:
        body['sha'] = sha
    api('/repos/%s/contents/%s' % (REPO, repo_path), body, 'PUT')
    print('committed:', repo_path)


def main():
    for repo_path, local_file in FILES:
        if not os.path.exists(local_file):
            print('WARNING: missing', local_file)
            continue
        put_file(repo_path, local_file, 'regen [skip ci]')


main()
