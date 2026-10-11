# Bhumivera Backend
- **Stack:** Node.js 22+, Express, MySQL (`mysql2`); CommonJS.
- **Entry point:** `server.js`.
- **Core directories:** `routes/` defines endpoints; `services/` contains business logic and integrations; `models/` handles data models; `middleware/` provides request middleware; `utils/` contains shared helpers; `config/` holds configuration; `migrations/` contains database migrations.
- Follow existing patterns and keep changes focused. When target files are named, work from those files; search only when needed to trace dependencies or verify behavior.
- Prefer concise responses and targeted diffs. Run the relevant tests or lint checks for code changes.
