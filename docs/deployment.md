# Deployment

Three supported shapes, in increasing order of how much of it you run yourself.

| | SaaS / cloud | Private cloud | Air-gapped |
|---|---|---|---|
| Infrastructure | `infra/terraform/aws` | your own cluster | your own everything |
| Install | Helm chart | Helm chart | offline bundle |
| AI providers | any | any reachable | `local` only |

## Cloud infrastructure — `infra/terraform/aws`

Provisions the data plane the Helm chart needs: a VPC across three availability
zones, RDS Postgres (Multi-AZ, with read replicas), ElastiCache Redis, an S3
bucket, and an IAM policy for object access.

```bash
cd infra/terraform/aws
terraform init
terraform apply -var region=eu-west-1 -var 'availability_zones=["eu-west-1a","eu-west-1b","eu-west-1c"]'
```

Outputs feed straight into the chart:

```bash
terraform output -raw database_url          # DATABASE_URL
terraform output -raw database_replica_url  # DATABASE_REPLICA_URL, or null
terraform output -raw redis_url             # REDIS_URL
terraform output -json helm_values          # storage settings
```

Read those into a secret manager, not into a values file in a repository.

Notable choices:

- **One NAT gateway per availability zone.** A single shared NAT is cheaper and
  is also a single point of failure for every private subnet at once.
- **`deletion_protection = true` by default.** A destroy that silently discards
  the database is not a mistake anyone should be able to make from a plan they
  skimmed.
- **A read replica by default.** The application routes analytics and reports to
  it and keeps every write and read-after-write on the primary. Set
  `db_replica_count = 0` for a single-node deployment; the application code is
  identical either way.
- **Versioning on the bucket.** Attachments and recordings are referenced by a
  database row; a delete that turns out to be wrong is recoverable while
  versioning is on and permanently wrong the moment it is not.
- **IRSA rather than an access key**, when `oidc_provider_arn` is supplied. A key
  in a Kubernetes secret outlives every rotation policy anyone writes down.

**This module has not been applied against a live AWS account.** Its syntax and
every variable, local and resource reference are checked, but `terraform
validate` needs the provider schema from the registry, which is not reachable
from the environment this was written in. Run `terraform plan` and read it
before you apply.

## Air-gapped install

```bash
scripts/package-airgap.sh                 # everything
scripts/package-airgap.sh --skip-images   # chart, migrations and SQL only
```

Produces `dist/airgap/atrrehub-<version>-airgap.tar.gz` containing the container
images, the Helm chart, the database migrations, the extension SQL, an
`INSTALL.md` written for a machine with no network, and a `MANIFEST.sha256`.

Verify the manifest on the far side before anything else. There is no way to
re-download a file that arrived corrupt.

The script refuses to build when `values.yaml` pins a different image tag than
the bundle version: a bundle whose chart and images disagree installs a version
nobody chose, on the far side of an air gap where nobody can correct it.

Two things an air-gapped install must get right:

- **`pgvector` must be built into your Postgres.** It is the one dependency the
  platform cannot work without and cannot bundle.
- **Set `aiDefaultProvider=local`, and set the governance policy's
  `allowedProviders` to `["local"]`.** The local provider is the only one that
  works without egress, and the allow-list stops somebody configuring a route
  that can never be reached.

## Load testing — `tools/loadtest/run.mjs`

```bash
node tools/loadtest/run.mjs --url https://api.example.com \
  --email operator@example.com --password '…' --vus 25 --duration 60 --rps 0
```

Plain Node rather than k6 or Artillery: a load test that needs a tool nobody has
installed is a load test nobody runs. It exits non-zero when a p95 threshold is
breached, so it can gate a release.

`--rps` caps offered load across all virtual users; `--rps 0` removes the cap.
**The cap exists because of what the first run found:** the API's default bucket
is 600 requests per minute *per principal*, so twenty unthrottled users signed in
as one person produced 44,753 rate-limited responses out of 49,747 — and the
percentiles measured the rate limiter rather than the API. 429s are now counted
separately from errors, and the report warns when they dominate.

To measure capacity rather than the limiter, raise `RATE_LIMIT_MULTIPLIER` on
the instance under test, or sign in as as many principals as the load you claim
to represent.

### Measured

One API process, Postgres and Redis on the same machine, `RATE_LIMIT_MULTIPLIER=1000`,
seeded data. Latency in milliseconds.

**25 concurrent users — 401 req/s, no errors**

| scenario | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| GET /conversations | 5436 | 45 | 62 | 73 | 109 |
| GET /customers | 3594 | 46 | 63 | 74 | 93 |
| GET /tickets | 3603 | 40 | 56 | 66 | 89 |
| GET /analytics/executive | 1800 | 38 | 56 | 65 | 92 |
| GET /knowledge/search | 1769 | 115 | 152 | 166 | 213 |
| POST /customers | 1848 | 152 | 197 | 220 | 259 |

**100 concurrent users — 432 req/s, no errors**

| scenario | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| GET /conversations | 5864 | 155 | 215 | 250 | 342 |
| GET /customers | 3861 | 155 | 215 | 245 | 354 |
| GET /tickets | 3911 | 150 | 208 | 242 | 341 |
| GET /analytics/executive | 1972 | 122 | 177 | 203 | 227 |
| GET /knowledge/search | 2034 | 496 | 627 | 669 | 768 |
| POST /customers | 1912 | 598 | 751 | 798 | 845 |

Quadrupling concurrency moved throughput from 401 to 432 req/s and multiplied
latency by about 3.5×. **A single node saturates at roughly 430 req/s**; past
about 25 concurrent users the extra requests queue rather than go faster. That
is the number to divide your expected traffic by when sizing `api.replicas`, and
the reason the chart defaults to three.

These figures come from a development machine with the database local. Treat
them as a shape — a plateau at a few hundred requests per second per process,
writes roughly 3× the cost of reads, knowledge search the slowest read — rather
than as a promise about your hardware. Nothing here has been run against
production-like infrastructure.
