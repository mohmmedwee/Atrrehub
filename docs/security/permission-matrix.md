# Permission matrix

Permissions are strings shaped `<resource>:<action>` and are additive. A role is a named
set of permissions; a membership binds a user to a role within an organization, and
optionally narrows it to specific workspaces or teams.

## Actions

`read` · `create` · `update` · `delete` · `assign` · `publish` · `execute` · `export` ·
`manage` (implies all actions on that resource)

## System roles

| Permission | Owner | Admin | Supervisor | QA Mgr | Agent | AI Builder | Analyst | Viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `organization:manage` | ● | ● | | | | | | |
| `organization:read` | ● | ● | ● | ● | ● | ● | ● | ● |
| `workspace:manage` | ● | ● | | | | | | |
| `billing:manage` | ● | | | | | | | |
| `billing:read` | ● | ● | | | | | ● | |
| `user:manage` | ● | ● | | | | | | |
| `user:read` | ● | ● | ● | ● | | | ● | ● |
| `role:manage` | ● | ● | | | | | | |
| `apikey:manage` | ● | ● | | | | ● | | |
| `audit:read` | ● | ● | | ● | | | ● | |
| `team:manage` | ● | ● | ● | | | | | |
| `queue:manage` | ● | ● | ● | | | | | |
| `taxonomy:manage` | ● | ● | ● | | | | | |
| `customer:read` | ● | ● | ● | ● | ● | ● | ● | ● |
| `customer:create` | ● | ● | ● | | ● | | | |
| `customer:update` | ● | ● | ● | | ● | | | |
| `customer:delete` | ● | ● | | | | | | |
| `customer:merge` | ● | ● | ● | | | | | |
| `customer:export` | ● | ● | | | | | ● | |
| `conversation:read` | ● | ● | ● | ● | ● | | ● | ● |
| `conversation:create` | ● | ● | ● | | ● | | | |
| `conversation:update` | ● | ● | ● | | ● | | | |
| `conversation:assign` | ● | ● | ● | | ● | | | |
| `conversation:read_all` | ● | ● | ● | ● | | | ● | |
| `message:create` | ● | ● | ● | | ● | | | |
| `ticket:read` | ● | ● | ● | ● | ● | | ● | ● |
| `ticket:create` | ● | ● | ● | | ● | | | |
| `ticket:update` | ● | ● | ● | | ● | | | |
| `ticket:delete` | ● | ● | | | | | | |
| `ticket:assign` | ● | ● | ● | | ● | | | |
| `sla:manage` | ● | ● | ● | | | | | |
| `sla:read` | ● | ● | ● | ● | ● | | ● | ● |
| `routing:manage` | ● | ● | ● | | | | | |
| `knowledge:read` | ● | ● | ● | ● | ● | ● | ● | ● |
| `knowledge:create` | ● | ● | ● | | | ● | | |
| `knowledge:update` | ● | ● | ● | | | ● | | |
| `knowledge:publish` | ● | ● | ● | | | ● | | |
| `knowledge:delete` | ● | ● | | | | | | |
| `agent:read` | ● | ● | ● | ● | | ● | ● | ● |
| `agent:create` | ● | ● | | | | ● | | |
| `agent:update` | ● | ● | | | | ● | | |
| `agent:publish` | ● | ● | | | | ● | | |
| `agent:execute` | ● | ● | ● | | ● | ● | | |
| `workflow:manage` | ● | ● | | | | ● | | |
| `execution:read` | ● | ● | ● | | | ● | ● | |
| `tool:manage` | ● | ● | | | | ● | | |
| `tool:execute` | ● | ● | | | ● | ● | | |
| `memory:read` | ● | ● | ● | ● | | ● | | |
| `memory:delete` | ● | ● | | | | ● | | |
| `guardrail:manage` | ● | ● | | | | ● | | |
| `copilot:execute` | ● | ● | ● | | ● | | | |
| `automation:manage` | ● | ● | ● | | | ● | | |
| `qc:template_manage` | ● | ● | | ● | | | | |
| `qc:evaluate` | ● | ● | ● | ● | | | | |
| `qc:read_own` | ● | ● | ● | ● | ● | | | |
| `qc:read_all` | ● | ● | ● | ● | | | ● | |
| `qc:dispute` | ● | ● | ● | ● | ● | | | |
| `qc:calibrate` | ● | ● | | ● | | | | |
| `analytics:read` | ● | ● | ● | ● | | | ● | ● |
| `analytics:read_all` | ● | ● | ● | ● | | | ● | |
| `report:manage` | ● | ● | ● | ● | | | ● | |
| `report:export` | ● | ● | ● | ● | | | ● | |
| `notification:manage` | ● | ● | ● | | | | | |
| `integration:manage` | ● | ● | | | | ● | | |
| `governance:manage` | ● | ● | | | | | | |
| `eval:manage` | ● | ● | | ● | | ● | | |

## Scoping rules

1. `*:read` without `*_all` is limited to records the user owns, is assigned to, or that
   belong to a team they are a member of.
2. Membership may pin a role to a subset of workspaces; permissions then apply only
   inside those workspaces.
3. Supervisors additionally inherit read access to their teams' records.
4. API keys carry an explicit permission subset that can never exceed the creating
   user's own permissions at creation time.
5. Permission checks are deny-by-default and evaluated at the service layer, not only
   in controllers.
