#!/usr/bin/env python3
"""Compose invocation-only settings without changing installed configuration."""
import json
import sys


def compose(documents):
    merged = {}
    for document in documents:
        if document.lstrip().startswith('{'):
            value = json.loads(document)
        else:
            with open(document, encoding='utf-8') as source:
                value = json.load(source)
        if not isinstance(value, dict):
            raise ValueError('settings must be a JSON object')
        # Claude accepts one additional document: the last caller document wins.
        merged = value
    plugins = merged.get('enabledPlugins', {})
    if not isinstance(plugins, dict):
        raise ValueError('enabledPlugins must be a JSON object')
    merged['enabledPlugins'] = {**plugins, 'telegram@claude-plugins-official': False}
    return merged


if __name__ == '__main__':
    try:
        print(json.dumps(compose(sys.argv[1:]), separators=(',', ':')))
    except (OSError, ValueError) as error:
        print(f'headless settings: {error}', file=sys.stderr)
        sys.exit(2)
