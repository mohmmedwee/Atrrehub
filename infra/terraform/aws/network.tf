# The network the data stores live in.
#
# Nothing here is public. The database and cache sit in private subnets with no
# route to the internet, and the only things that may reach them are the
# security groups this module creates — the application's, and nothing else.

locals {
  azs = slice(var.availability_zones, 0, min(length(var.availability_zones), 3))

  tags = merge(
    {
      Application = var.name
      ManagedBy   = "terraform"
    },
    var.tags,
  )
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = var.name })
}

# Private subnets carry the data stores. Their CIDRs are derived rather than
# listed so that adding an availability zone does not mean editing a variable
# and getting the arithmetic wrong.
resource "aws_subnet" "private" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, each.value)

  tags = merge(local.tags, {
    Name                              = "${var.name}-private-${each.key}"
    "kubernetes.io/role/internal-elb" = "1"
  })
}

# Public subnets exist only for load balancers and NAT. Offset well clear of the
# private range so the two never collide as either grows.
resource "aws_subnet" "public" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, each.value + 8)
  map_public_ip_on_launch = true

  tags = merge(local.tags, {
    Name                     = "${var.name}-public-${each.key}"
    "kubernetes.io/role/elb" = "1"
  })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = var.name })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# One NAT gateway per availability zone. A single shared NAT is cheaper and is
# also a single point of failure for every private subnet at once — which is
# the thing this module exists to avoid.
resource "aws_eip" "nat" {
  for_each = aws_subnet.public

  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat-${each.key}" })
}

resource "aws_nat_gateway" "main" {
  for_each = aws_subnet.public

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = each.value.id
  depends_on    = [aws_internet_gateway.main]

  tags = merge(local.tags, { Name = "${var.name}-${each.key}" })
}

resource "aws_route_table" "private" {
  for_each = aws_subnet.private

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[each.key].id
  }

  tags = merge(local.tags, { Name = "${var.name}-private-${each.key}" })
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

# ── Security groups ──────────────────────────────────────────────────────────

# What the application runs as. Attach this to the API and worker pods (via a
# security group policy) or to the nodes; it is the only thing the data stores
# accept connections from.
resource "aws_security_group" "application" {
  name        = "${var.name}-application"
  description = "The API and worker tiers"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "Outbound to the data stores, AI providers and channel APIs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${var.name}-application" })
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "Postgres — reachable only from the application"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from the application tier"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.application.id]
  }

  tags = merge(local.tags, { Name = "${var.name}-database" })
}

resource "aws_security_group" "cache" {
  name        = "${var.name}-cache"
  description = "Redis — reachable only from the application"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from the application tier"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.application.id]
  }

  tags = merge(local.tags, { Name = "${var.name}-cache" })
}
