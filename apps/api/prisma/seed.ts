/**
 * Development seed.
 *
 * Creates a complete, believable tenant so the platform can be explored
 * immediately: people with skills, queues, knowledge, an AI agent, automation,
 * a QC scorecard and conversations at several stages of their lifecycle.
 *
 * Run with `pnpm db:seed`. Safe to re-run — it clears the demo organization
 * first rather than accumulating duplicates.
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { RequestContextStore } from '../src/core/context/request-context';
import { CryptoService } from '../src/core/crypto/crypto.service';
import { newId, newReference } from '../src/core/ids/id.service';
import { SYSTEM_ROLES, type RoleKey } from '../src/modules/auth/permissions';
import { DEFAULT_QC_CRITERIA } from '../src/modules/quality/quality.service';

const prisma = new PrismaClient();
const crypto = new CryptoService('seed-encryption-key-that-is-long-enough-0000');

const DEMO_SLUG = 'atrrehub-demo';
const PASSWORD = 'Str0ngPassword!23';

async function main() {
  console.info('Seeding the demo organization…');

  const existing = await prisma.organization.findUnique({ where: { slug: DEMO_SLUG } });
  if (existing) {
    // Cascades remove everything the tenant owns, so a re-run is idempotent.
    await prisma.organization.delete({ where: { id: existing.id } });
    console.info('  removed the previous demo organization');
  }

  const organizationId = newId('organization');
  const passwordHash = await crypto.hashPassword(PASSWORD);

  const organization = await prisma.organization.create({
    data: {
      id: organizationId,
      name: 'Atrrehub Demo',
      slug: DEMO_SLUG,
      plan: 'business',
      timezone: 'UTC',
      locale: 'en',
      defaultLanguage: 'en',
      supportEmail: 'support@atrrehub.demo',
      primaryColor: '#2563eb',
    },
  });

  // ── Roles ────────────────────────────────────────────────────────────────
  const roles = await Promise.all(
    (Object.keys(SYSTEM_ROLES) as RoleKey[]).map((key) =>
      prisma.role.create({
        data: {
          id: newId('role'),
          organizationId,
          key,
          name: SYSTEM_ROLES[key].name,
          description: SYSTEM_ROLES[key].description,
          permissions: SYSTEM_ROLES[key].permissions,
          isSystem: true,
        },
      }),
    ),
  );
  const roleByKey = new Map(roles.map((role) => [role.key, role]));

  // ── People ───────────────────────────────────────────────────────────────
  const people = [
    {
      email: 'owner@atrrehub.demo',
      firstName: 'Ada',
      lastName: 'Haddad',
      role: 'owner',
      skills: [],
      languages: ['en'],
    },
    {
      email: 'supervisor@atrrehub.demo',
      firstName: 'Omar',
      lastName: 'Khalil',
      role: 'supervisor',
      skills: ['billing', 'network'],
      languages: ['en', 'ar'],
    },
    {
      email: 'agent@atrrehub.demo',
      firstName: 'Layla',
      lastName: 'Nasser',
      role: 'agent',
      skills: ['billing'],
      languages: ['en', 'ar'],
    },
    {
      email: 'agent2@atrrehub.demo',
      firstName: 'Sam',
      lastName: 'Rivera',
      role: 'agent',
      skills: ['network'],
      languages: ['en'],
    },
    {
      email: 'builder@atrrehub.demo',
      firstName: 'Noor',
      lastName: 'Aziz',
      role: 'ai_builder',
      skills: [],
      languages: ['en'],
    },
    {
      email: 'qa@atrrehub.demo',
      firstName: 'Tariq',
      lastName: 'Mansour',
      role: 'qa_manager',
      skills: [],
      languages: ['en'],
    },
  ];

  const users = [];
  for (const person of people) {
    const userId = newId('user');
    await prisma.user.create({
      data: {
        id: userId,
        email: person.email,
        passwordHash,
        firstName: person.firstName,
        lastName: person.lastName,
        status: 'active',
        emailVerifiedAt: new Date(),
        presence: person.role === 'agent' ? 'available' : 'offline',
        skills: person.skills,
        languages: person.languages,
      },
    });
    await prisma.membership.create({
      data: {
        id: newId('membership'),
        organizationId,
        userId,
        roleId: roleByKey.get(person.role)!.id,
        isOwner: person.role === 'owner',
        acceptedAt: new Date(),
      },
    });
    users.push({ ...person, id: userId });
  }
  const agents = users.filter((user) => user.role === 'agent');

  // ── Workspace, calendars, SLA ────────────────────────────────────────────
  const workspace = await prisma.workspace.create({
    data: {
      id: newId('workspace'),
      organizationId,
      name: 'Default',
      slug: 'default',
      environment: 'production',
      isDefault: true,
    },
  });

  const alwaysOn = await prisma.businessHours.create({
    data: {
      id: newId('businessHours'),
      organizationId,
      name: 'Around the clock',
      timezone: 'UTC',
      rules: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '23:59' })),
      isDefault: true,
    },
  });

  const officeHours = await prisma.businessHours.create({
    data: {
      id: newId('businessHours'),
      organizationId,
      name: 'Office hours (Sun–Thu)',
      timezone: 'Asia/Amman',
      // A working week that is not Monday–Friday, which the SLA maths must handle.
      rules: [0, 1, 2, 3, 4].map((day) => ({ day, start: '09:00', end: '17:00' })),
    },
  });

  await prisma.holiday.createMany({
    data: [
      {
        id: newId('holiday'),
        organizationId,
        businessHoursId: officeHours.id,
        name: 'New Year',
        date: new Date('2026-01-01'),
        recurring: true,
      },
      {
        id: newId('holiday'),
        organizationId,
        businessHoursId: officeHours.id,
        name: 'Independence Day',
        date: new Date('2026-05-25'),
        recurring: true,
      },
    ],
  });

  const slaPolicy = await prisma.slaPolicy.create({
    data: {
      id: newId('slaPolicy'),
      organizationId,
      name: 'Standard SLA',
      description: 'Applies unless a more specific policy matches',
      businessHoursId: alwaysOn.id,
      isDefault: true,
    },
  });

  const targets: [string, string, number][] = [
    ['first_response', 'low', 480],
    ['first_response', 'normal', 240],
    ['first_response', 'high', 60],
    ['first_response', 'urgent', 30],
    ['first_response', 'critical', 15],
    ['resolution', 'low', 4320],
    ['resolution', 'normal', 2880],
    ['resolution', 'high', 480],
    ['resolution', 'urgent', 240],
    ['resolution', 'critical', 60],
  ];
  await prisma.slaTarget.createMany({
    data: targets.map(([type, priority, minutes]) => ({
      id: newId('slaTarget'),
      organizationId,
      policyId: slaPolicy.id,
      type: type as never,
      priority: priority as never,
      durationMinutes: minutes,
      warningPercent: 75,
    })),
  });

  // ── Teams and queues ─────────────────────────────────────────────────────
  const billingTeam = await prisma.team.create({
    data: {
      id: newId('team'),
      organizationId,
      workspaceId: workspace.id,
      name: 'Billing',
      skills: ['billing'],
      languages: ['en', 'ar'],
      businessHoursId: alwaysOn.id,
    },
  });
  await prisma.teamMember.createMany({
    data: agents.map((agent) => ({
      id: newId('teamMember'),
      teamId: billingTeam.id,
      userId: agent.id,
    })),
  });

  const generalQueue = await prisma.queue.create({
    data: {
      id: newId('queue'),
      organizationId,
      workspaceId: workspace.id,
      name: 'General',
      key: 'general',
      description: 'Default queue, AI answers first',
      strategy: 'round_robin',
      slaPolicyId: slaPolicy.id,
      businessHoursId: alwaysOn.id,
      aiFirst: true,
    },
  });

  await prisma.queue.create({
    data: {
      id: newId('queue'),
      organizationId,
      workspaceId: workspace.id,
      name: 'Arabic support',
      key: 'arabic',
      description: 'Arabic-language conversations',
      strategy: 'language',
      languages: ['ar'],
      slaPolicyId: slaPolicy.id,
      businessHoursId: officeHours.id,
    },
  });

  // ── Taxonomy and channels ────────────────────────────────────────────────
  await prisma.tag.createMany({
    data: ['billing', 'network', 'vip', 'at-risk', 'refund'].map((name) => ({
      id: newId('tag'),
      organizationId,
      name,
      color: '#64748b',
    })),
  });

  await prisma.customField.create({
    data: {
      id: newId('customField'),
      organizationId,
      entity: 'customer',
      key: 'accountNumber',
      label: 'Account number',
      type: 'text',
    },
  });

  await prisma.channelAccount.createMany({
    data: [
      {
        id: newId('channelAccount'),
        organizationId,
        workspaceId: workspace.id,
        channel: 'web_chat',
        name: 'Website chat',
        queueId: generalQueue.id,
        config: { greeting: 'Hello! How can we help today?', title: 'Atrrehub Demo support' },
      },
      {
        id: newId('channelAccount'),
        organizationId,
        workspaceId: workspace.id,
        channel: 'email',
        name: 'Support inbox',
        queueId: generalQueue.id,
        config: { signature: 'The Atrrehub Demo support team' },
      },
    ],
  });

  // ── Guardrails and governance ────────────────────────────────────────────
  const guardrail = await prisma.guardrailPolicy.create({
    data: {
      id: newId('guardrail'),
      organizationId,
      name: 'Default guardrails',
      description: 'Baseline safety controls for every agent',
      rules: [
        { stage: 'input', check: 'prompt_injection', action: 'handoff', severity: 'high' },
        {
          stage: 'input',
          check: 'max_length',
          action: 'block',
          severity: 'low',
          config: { maxChars: 8000 },
        },
        { stage: 'tool', check: 'egress_allowlist', action: 'block', severity: 'high' },
        { stage: 'output', check: 'pii', action: 'mask', severity: 'medium' },
        { stage: 'output', check: 'content_policy', action: 'block', severity: 'high' },
        { stage: 'output', check: 'groundedness', action: 'flag', severity: 'medium' },
      ],
      confidenceThreshold: 0.6,
      isDefault: true,
    },
  });

  await prisma.governancePolicy.create({
    data: {
      id: newId('governance'),
      organizationId,
      dataRetentionDays: 365,
      monthlyCostLimitUsd: 500,
    },
  });

  await prisma.ticketCounter.create({ data: { organizationId, nextNumber: 1 } });

  // ── Knowledge ────────────────────────────────────────────────────────────
  const knowledgeBase = await prisma.knowledgeBase.create({
    data: {
      id: newId('knowledgeBase'),
      organizationId,
      workspaceId: workspace.id,
      name: 'Support knowledge',
      key: 'support',
      description: 'Policies and procedures that ground every AI answer',
    },
  });

  const articles = [
    {
      title: 'Refund policy',
      body: 'Customers may request a refund within 30 days of purchase. Once approved by the billing team, refunds are processed within three working days and appear on the original payment method within five working days. Original shipping charges are not refunded unless the item arrived damaged.',
    },
    {
      title: 'Password reset',
      body: 'To reset a password, open Account settings and choose Forgot password. A reset link is sent to the registered email address and expires after 30 minutes. If the email does not arrive, check the spam folder and confirm the address on file is current.',
    },
    {
      title: 'Service outage credits',
      body: 'During a confirmed service outage lasting more than four hours, affected customers receive a pro-rata credit on their next invoice. Credits are applied automatically and appear on the following billing cycle. No claim is required.',
    },
    {
      title: 'International roaming',
      body: 'Roaming is disabled by default on new accounts. It can be enabled from Account settings or by contacting support. Rates vary by destination and are published on the rates page; charges appear on the invoice for the month in which they were incurred.',
    },
  ];

  for (const article of articles) {
    const articleId = newId('article');
    await prisma.article.create({
      data: {
        id: articleId,
        organizationId,
        knowledgeBaseId: knowledgeBase.id,
        title: article.title,
        slug: article.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        body: article.body,
        state: 'published',
        publishedAt: new Date(),
        authorId: users[0].id,
      },
    });
    // Documents and chunks are created by the ingestion pipeline when the API
    // publishes; seeding the article alone keeps this script free of AI calls.
  }

  // ── AI agent ─────────────────────────────────────────────────────────────
  const agentId = newId('agent');
  const agentVersionId = newId('agentVersion');
  await prisma.agent.create({
    data: {
      id: agentId,
      organizationId,
      workspaceId: workspace.id,
      name: 'Support Assistant',
      key: 'support_assistant',
      description: 'Answers billing, account and outage questions from the knowledge base',
      state: 'published',
      activeVersionId: agentVersionId,
      createdById: users[4].id,
    },
  });
  await prisma.agentVersion.create({
    data: {
      id: agentVersionId,
      organizationId,
      agentId,
      version: 1,
      instructions:
        'You are a support agent for Atrrehub Demo. Answer only from the context provided. If the context does not contain the answer, say so plainly and hand the conversation to a colleague. Never invent policy, prices or timescales.',
      modelRole: 'chat',
      temperature: 0.2,
      knowledgeBaseIds: [knowledgeBase.id],
      toolIds: ['knowledge_search', 'customer_lookup', 'create_ticket'],
      guardrailPolicyId: guardrail.id,
      handoffRules: { confidenceThreshold: 0.6, onRequest: true },
      greeting: 'Hello! How can we help today?',
      fallbackMessage: 'Let me pass you to a colleague who can help with that.',
      environment: 'production',
      publishedAt: new Date(),
      publishedById: users[4].id,
    },
  });
  await prisma.queue.update({ where: { id: generalQueue.id }, data: { aiAgentId: agentId } });

  // ── Automation and quality ───────────────────────────────────────────────
  await prisma.automationRule.create({
    data: {
      id: newId('automation'),
      organizationId,
      name: 'Escalate unhappy priority customers',
      trigger: 'sentiment_changed',
      conditions: {
        all: [{ field: 'customer.tier', op: 'eq', value: 'gold' }],
        expression: 'ai.sentimentScore < -0.3',
      },
      actions: [
        { type: 'set_priority', config: { priority: 'urgent' } },
        { type: 'add_tag', config: { tag: 'at-risk' } },
      ],
      createdById: users[1].id,
    },
  });

  const qcTemplateId = newId('qcTemplate');
  await prisma.qcTemplate.create({
    data: {
      id: qcTemplateId,
      organizationId,
      name: 'Standard support scorecard',
      description: 'Applies to every channel',
      autoEvaluate: true,
      samplePercent: 100,
      passingScore: 80,
    },
  });
  await prisma.qcCriterion.createMany({
    data: DEFAULT_QC_CRITERIA.map((criterion, index) => ({
      id: newId('qcCriterion'),
      organizationId,
      templateId: qcTemplateId,
      category: criterion.category,
      name: criterion.name,
      weight: criterion.weight,
      rubric: criterion.rubric,
      isCritical: criterion.isCritical ?? false,
      position: index,
    })),
  });

  // ── Customers and conversations ──────────────────────────────────────────
  const customers = [
    {
      first: 'Nadia',
      last: 'Farah',
      company: 'Northwind Trading',
      tier: 'gold',
      email: 'nadia@northwind.demo',
      locale: 'en',
    },
    {
      first: 'Yusuf',
      last: 'Rahman',
      company: 'Cedar Logistics',
      tier: 'silver',
      email: 'yusuf@cedar.demo',
      locale: 'ar',
    },
    {
      first: 'Hana',
      last: 'Suleiman',
      company: null,
      tier: null,
      email: 'hana@example.demo',
      locale: 'en',
    },
  ];

  const created = [];
  for (const customer of customers) {
    const customerId = newId('customer');
    await prisma.customer.create({
      data: {
        id: customerId,
        organizationId,
        workspaceId: workspace.id,
        firstName: customer.first,
        lastName: customer.last,
        displayName: `${customer.first} ${customer.last}`,
        company: customer.company,
        tier: customer.tier,
        locale: customer.locale,
        tags: customer.tier === 'gold' ? ['vip'] : [],
      },
    });
    await prisma.contactMethod.create({
      data: {
        id: newId('contactMethod'),
        organizationId,
        customerId,
        kind: 'email',
        value: customer.email,
        normalized: customer.email.toLowerCase(),
        isPrimary: true,
      },
    });
    created.push({ ...customer, id: customerId });
  }

  const scenarios = [
    {
      customer: created[0],
      subject: 'Charged twice for March',
      status: 'resolved',
      priority: 'high',
      channel: 'email',
      body: 'My March invoice shows the same charge twice. Can you check?',
    },
    {
      customer: created[1],
      subject: 'Roaming not working in Japan',
      status: 'active',
      priority: 'normal',
      channel: 'web_chat',
      body: 'I enabled roaming but my phone has no data in Japan.',
    },
    {
      customer: created[2],
      subject: 'Outage credit',
      status: 'queued',
      priority: 'normal',
      channel: 'email',
      body: 'We had no service for most of Tuesday. Is there a credit?',
    },
  ];

  for (const scenario of scenarios) {
    const conversationId = newId('conversation');
    const assignee =
      scenario.status === 'queued' ? null : agents[scenarios.indexOf(scenario) % agents.length];
    const createdAt = new Date(Date.now() - (scenarios.indexOf(scenario) + 1) * 3_600_000);

    await prisma.conversation.create({
      data: {
        id: conversationId,
        organizationId,
        workspaceId: workspace.id,
        reference: newReference('C'),
        channel: scenario.channel as never,
        customerId: scenario.customer.id,
        subject: scenario.subject,
        status: scenario.status as never,
        priority: scenario.priority as never,
        queueId: generalQueue.id,
        assigneeType: assignee ? 'user' : 'none',
        assigneeId: assignee?.id ?? null,
        assignedAt: assignee ? createdAt : null,
        locale: scenario.customer.locale,
        createdAt,
        lastMessageAt: createdAt,
        messageCount: assignee ? 2 : 1,
        firstResponseAt: assignee ? new Date(createdAt.getTime() + 240_000) : null,
        resolvedAt:
          scenario.status === 'resolved' ? new Date(createdAt.getTime() + 1_800_000) : null,
        csatScore: scenario.status === 'resolved' ? 5 : null,
      },
    });

    await prisma.message.create({
      data: {
        id: newId('message'),
        organizationId,
        conversationId,
        direction: 'inbound',
        type: 'text',
        authorType: 'customer',
        authorId: scenario.customer.id,
        authorName: `${scenario.customer.first} ${scenario.customer.last}`,
        body: scenario.body,
        deliveryState: 'delivered',
        createdAt,
      },
    });

    if (assignee) {
      await prisma.message.create({
        data: {
          id: newId('message'),
          organizationId,
          conversationId,
          direction: 'outbound',
          type: 'text',
          authorType: 'user',
          authorId: assignee.id,
          authorName: `${assignee.firstName} ${assignee.lastName}`,
          body: 'Thanks for getting in touch — I am looking into this now and will come back to you shortly.',
          deliveryState: 'sent',
          createdAt: new Date(createdAt.getTime() + 240_000),
        },
      });
    }
  }

  console.info(`
Seed complete.

  Organization : ${organization.name} (${organization.slug})
  Sign in at   : http://localhost:3000/login

  owner@atrrehub.demo       ${PASSWORD}   (full access)
  supervisor@atrrehub.demo  ${PASSWORD}
  agent@atrrehub.demo       ${PASSWORD}   (available, billing + Arabic)
  builder@atrrehub.demo     ${PASSWORD}   (AI Studio)
  qa@atrrehub.demo          ${PASSWORD}   (quality)

  ${customers.length} customers, ${scenarios.length} conversations, ${articles.length} knowledge articles,
  1 published AI agent on an AI-first queue.

  Knowledge articles still need indexing for retrieval — publish one from the
  admin console, or POST /api/v1/knowledge/articles/:id/publish.
`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
