# Security policy

devbar runs `git`, `gh`, `docker` and a few system tools inside whatever repository you open in Claude Code, including repositories you did not write. A flaw that lets a repository run code, leak data or slip text into a prompt through devbar is a security issue. The [Safety and privacy](README.md#safety-and-privacy) section of the README lists what devbar defends against today.

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for it.

Include, if you can:

- what an attacker controls (for example, a cloned repository's files or its `.git/config`);
- the steps to reproduce, with the operating system and the `git` version;
- what happens and what should have happened.

Reports are answered as soon as possible. Once a fix is out, the report can be made public, crediting you if you want.

## Supported versions

Only the latest version gets security fixes.
