# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public issue
2. Email: info@auroracapital.nl
3. Include: description, reproduction steps, impact assessment

We'll respond within 48 hours and work with you on a fix before public disclosure.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | ✅        |
| < 0.3   | ❌        |

## Security Features

- **Secret scanning**: `.gitleaks.toml` + GitHub secret scanning + push protection enabled
- **No secrets in code**: All tokens stored in macOS keychain, never in dotfiles or config
- **Encrypted cookie handling**: Browser cookie decryption uses the app's own keychain key
- **File permissions**: All temp files created with `umask 077` (mode 0600)
