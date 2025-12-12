# Skills

Skills are specialized instruction sets that the agent can load on-demand to handle specific tasks. They provide a way to package domain expertise into reusable modules.

## How Skills Work

1. **Discovery**: At startup, the agent scans for skill files in these locations (in order of precedence, later overrides earlier on name collision):
   - `~/.claude/skills/*/SKILL.md` (Claude Code user skills)
   - `.claude/skills/*/SKILL.md` (Claude Code project skills)
   - `~/.pi/agent/skills/*.md` (Pi user skills)
   - `.pi/skills/*.md` (Pi project skills)

2. **System Prompt**: Skill names, descriptions, and file paths are listed in the system prompt, so the agent knows what skills are available.

3. **Loading**: When the agent determines a skill matches the current task, it uses the `read` tool to load the skill file.

4. **Execution**: The agent follows the instructions in the skill file, substituting `{baseDir}` placeholders with the skill's base directory path.

## Compatibility

Pi supports both its native skill format and Claude Code skills:

| Feature | Pi Skills | Claude Code Skills |
|---------|-----------|-------------------|
| Location | `~/.pi/agent/skills/*.md` | `~/.claude/skills/*/SKILL.md` |
| Structure | Flat files | Directory with SKILL.md |
| Frontmatter | `name`, `description` | `name`, `description`, `allowed-tools`, `model` |
| Tool filtering | Not supported | Ignored |
| Model override | Not supported | Ignored |

Claude Code's `allowed-tools` and `model` frontmatter fields are ignored by Pi.

## Creating Skills

Skills are markdown files with YAML frontmatter. A file becomes a skill when it has a `description` field in its frontmatter.

### Basic Structure

```markdown
---
description: Extract text and tables from PDF files
---

# PDF Processing Instructions

When working with PDF files:

1. Use `pdftotext` to extract plain text
2. For tables, use `tabula-py` or similar tools
3. Always verify extraction quality

## Available Scripts

Run scripts from: {baseDir}/scripts/
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Short description shown to the agent for skill selection |
| `name` | No | Override the skill name (defaults to filename or directory name) |

### Variables

- `{baseDir}` - The directory containing the skill file. Use this to reference bundled scripts or resources.

### Subdirectories (Pi Skills Only)

Pi skills in subdirectories are named with a colon separator. For example:
- `skills/db/migrate.md` becomes skill `db:migrate`
- `skills/aws/s3/upload.md` becomes skill `aws:s3:upload`

## Disabling Skills

Skills can be disabled via:

1. **CLI flag**: `--no-skills`
2. **Settings**: Set `skills.enabled` to `false` in `~/.pi/agent/settings.json`:

```json
{
  "skills": {
    "enabled": false
  }
}
```

## Example Skills

### Code Review Skill

```markdown
---
description: Perform thorough code review with security and performance analysis
---

# Code Review Instructions

When reviewing code, analyze:

## Security
- Input validation
- SQL injection risks
- XSS vulnerabilities
- Authentication/authorization

## Performance
- Algorithm complexity
- Memory usage
- Database query efficiency

## Maintainability
- Code clarity
- Test coverage
- Documentation
```

### Database Migration Skill

```markdown
---
description: Create and validate database migrations safely
---

# Database Migration Guidelines

## Before Creating Migrations

1. Back up the database
2. Review existing schema
3. Plan rollback strategy

## Migration Best Practices

- Keep migrations small and focused
- Always include rollback logic
- Test on staging first
- Document breaking changes

## Scripts

Use the migration helper: `{baseDir}/scripts/migrate.sh`
```
