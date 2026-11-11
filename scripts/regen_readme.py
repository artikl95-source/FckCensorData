#!/usr/bin/env python3
# Inserts the "Мои треки" section (from custom/meta.json) into README.md,
# keeping the upstream table intact. Idempotent: replaces our section if present.
import json
import os
import html

MARKER = '## Автоматически подменяемые треки'
SECTION_TITLE = '## Мои треки (добавленные вручную)'


def main():
    with open('README.md', 'r', encoding='utf-8') as f:
        readme = f.read()

    meta = {}
    if os.path.exists('meta.json'):
        try:
            with open('meta.json', 'r', encoding='utf-8') as f:
                meta = json.load(f)
        except Exception as e:
            print('WARNING: bad meta.json:', e)

    lines = [SECTION_TITLE, '']
    if meta:
        lines += ['', '<table><tbody>']
        for tid, m in meta.items():
            title = html.escape(m.get('title', tid))
            artist = html.escape(m.get('artist', ''))
            cover = m.get('cover', '')
            img = (f'<img width="40px" height="40px" src="{html.escape(cover)}" alt="{title}">'
                   if cover else '')
            lines += ['<tr>',
                      f'<td>{img}</td>',
                      f'<td><a href="https://music.yandex.ru/track/{tid}">{title}</a></td>',
                      f'<td>{artist}</td>',
                      '</tr>']
        lines += ['</tbody></table>']
    else:
        lines += ['_Пока пусто._']
    section = '\n'.join(lines) + '\n'

    start = readme.find(SECTION_TITLE)
    if start >= 0:
        # replace our old section (up to the next '## ' or EOF)
        nxt = readme.find('\n## ', start + len(SECTION_TITLE))
        end = len(readme) if nxt < 0 else nxt + 1
        readme = readme[:start] + section + '\n' + readme[end:]
    else:
        anchor = readme.find(MARKER)
        if anchor >= 0:
            readme = readme[:anchor] + section + '\n' + readme[anchor:]
        else:
            readme = readme + '\n' + section

    with open('README.md', 'w', encoding='utf-8') as f:
        f.write(readme)
    print('README updated, custom tracks:', len(meta))


main()
