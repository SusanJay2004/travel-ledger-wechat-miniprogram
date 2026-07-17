import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertApplyAuthorized,
  assertPlanApplyAuthorized,
  buildCreateIndex,
  buildInfrastructurePlan,
  isInfrastructureConverged,
  loadInfrastructureManifest,
  parseCliJson,
  redactPrivateValue,
} from './cloud-infrastructure.mjs';

const manifest = loadInfrastructureManifest(
  JSON.parse(readFileSync('config/cloud-database-indexes.json', 'utf8')),
  JSON.parse(readFileSync('config/cloud-database-rules.json', 'utf8')),
  JSON.parse(readFileSync('config/cloud-storage-rules.json', 'utf8')),
);

function exactRemoteState() {
  const collections = {};
  const databaseRules = {};
  for (const collection of manifest.collections) {
    collections[collection] = {
      indexes: [
        { Name: '_id_', Unique: true, Keys: [{ Name: '_id', Direction: '1' }] },
        ...manifest.indexes
          .filter((index) => index.collection === collection)
          .map((index) => ({
            Name: buildCreateIndex(index).IndexName,
            Unique: index.unique,
            Keys: index.fields.map((field) => ({
              Name: field.field,
              Direction: field.order === 'ASC' ? '1' : '-1',
            })),
          })),
      ],
    };
    databaseRules[collection] = {
      acl: 'CUSTOM',
      rule: JSON.stringify(manifest.databaseRules[collection]),
    };
  }
  return {
    collections,
    databaseRules,
    storageRule: { acl: 'CUSTOM', rule: manifest.storageRule },
  };
}

describe('cloud infrastructure planning', () => {
  it('recognizes the exact 12-collection and 34-index state including the built-in id index', () => {
    expect(manifest.collections).toHaveLength(12);
    expect(manifest.indexes).toHaveLength(34);
    const plan = buildInfrastructurePlan(manifest, exactRemoteState());
    expect(isInfrastructureConverged(plan)).toBe(true);
    expect(plan).toMatchObject({
      missingCollections: [],
      missingIndexes: [],
      databaseRuleUpdates: [],
      storageRuleUpdate: false,
      unknownCollections: [],
      unknownIndexes: [],
    });
  });

  it('accepts the platform id index even when the API omits its unique flag', () => {
    const remote = exactRemoteState();
    remote.collections.users.indexes[0].Unique = undefined;
    expect(buildInfrastructurePlan(manifest, remote).unknownIndexes).toEqual([]);
  });

  it('parses string false from DescribeTable without treating it as unique', () => {
    const remote = exactRemoteState();
    const normalIndex = remote.collections.users.indexes.find((index) => index.Unique === false);
    normalIndex.Unique = 'false';
    expect(buildInfrastructurePlan(manifest, remote).missingIndexes).toEqual([]);
  });

  it('plans only missing resources and full rule replacements', () => {
    const remote = exactRemoteState();
    delete remote.collections.trips;
    delete remote.databaseRules.trips;
    remote.collections.users.indexes = remote.collections.users.indexes.filter(
      (index) => index.Keys[0]?.Name !== 'publicId',
    );
    remote.databaseRules.users = { acl: 'READONLY', rule: null };
    remote.storageRule = { acl: 'ADMINONLY', rule: null };

    const plan = buildInfrastructurePlan(manifest, remote);
    expect(plan.missingCollections).toEqual(['trips']);
    expect(plan.missingIndexes.some((index) => index.collection === 'users')).toBe(true);
    expect(plan.databaseRuleUpdates).toEqual(['users']);
    expect(plan.storageRuleUpdate).toBe(true);
    expect(plan.unknownIndexes).toEqual([]);
  });

  it('surfaces unknown collections and indexes instead of planning deletion', () => {
    const remote = exactRemoteState();
    remote.collections.unmanaged = { indexes: [] };
    remote.collections.users.indexes.push({
      Name: 'manual_extra',
      Unique: false,
      Keys: [{ Name: 'manualField', Direction: 1 }],
    });
    const plan = buildInfrastructurePlan(manifest, remote);
    expect(plan.unknownCollections).toEqual(['unmanaged']);
    expect(plan.unknownIndexes).toHaveLength(1);
    expect(plan.unknownIndexes[0]).toMatchObject({ collection: 'users', name: 'manual_extra' });
    expect(JSON.stringify(plan)).not.toContain('DropIndexes');
  });

  it('treats a duplicate structural index as an unknown extra resource', () => {
    const remote = exactRemoteState();
    const duplicate = JSON.parse(JSON.stringify(remote.collections.users.indexes[1]));
    duplicate.Name = 'duplicate_manual_name';
    remote.collections.users.indexes.push(duplicate);
    const plan = buildInfrastructurePlan(manifest, remote);
    expect(plan.missingIndexes).toEqual([]);
    expect(plan.unknownIndexes).toHaveLength(1);
    expect(plan.unknownIndexes[0].name).toBe('duplicate_manual_name');
  });

  it('builds deterministic incremental CreateIndexes entries without drop instructions', () => {
    const desc = manifest.indexes.find((index) =>
      index.fields.some((field) => field.order === 'DESC'),
    );
    const request = buildCreateIndex(desc);
    expect(request.IndexName).toMatch(/^tl_[A-Za-z0-9_]+_[0-9a-f]{10}$/);
    expect(request.IndexName.length).toBeLessThanOrEqual(64);
    expect(request.MgoKeySchema.MgoIndexKeys).toContainEqual({
      Name: 'createdAt',
      Direction: '-1',
    });
    expect(request).not.toHaveProperty('DropIndexes');
  });
});

describe('cloud infrastructure write authorization', () => {
  it('requires separate infrastructure and full-rule-replacement acknowledgements', () => {
    const profile = { productMode: 'solo', deploymentStage: 'development' };
    expect(() => assertApplyAuthorized(profile, {})).toThrow(/CONFIRM_CLOUD_INFRASTRUCTURE/);
    expect(() =>
      assertApplyAuthorized(profile, {
        CONFIRM_CLOUD_INFRASTRUCTURE: 'APPLY_REVIEWED_INFRASTRUCTURE',
      }),
    ).toThrow(/CONFIRM_RULE_REPLACEMENT/);
    expect(() =>
      assertApplyAuthorized(profile, {
        CONFIRM_CLOUD_INFRASTRUCTURE: 'APPLY_REVIEWED_INFRASTRUCTURE',
        CONFIRM_RULE_REPLACEMENT: 'REPLACE_REVIEWED_CLIENT_RULES',
      }),
    ).not.toThrow();
  });

  it('rechecks collaboration and production approvals at apply time', () => {
    const acknowledgements = {
      CONFIRM_CLOUD_INFRASTRUCTURE: 'APPLY_REVIEWED_INFRASTRUCTURE',
      CONFIRM_RULE_REPLACEMENT: 'REPLACE_REVIEWED_CLIENT_RULES',
    };
    expect(() =>
      assertApplyAuthorized(
        { productMode: 'collaboration', deploymentStage: 'development' },
        acknowledgements,
      ),
    ).toThrow(/ALLOW_COLLABORATION_DEPLOY/);
    expect(() =>
      assertApplyAuthorized(
        { productMode: 'solo', deploymentStage: 'production' },
        acknowledgements,
      ),
    ).toThrow(/ALLOW_PRODUCTION_DEPLOY/);
  });

  it('requires an offline-environment acknowledgement before creating collections', () => {
    const plan = buildInfrastructurePlan(manifest, { collections: {} });
    expect(() => assertPlanApplyAuthorized(plan, {})).toThrow(/CONFIRM_COLLECTION_CREATION/);
    expect(() =>
      assertPlanApplyAuthorized(plan, {
        CONFIRM_COLLECTION_CREATION: 'CREATE_REVIEWED_EMPTY_COLLECTIONS',
      }),
    ).not.toThrow();
    expect(() =>
      assertPlanApplyAuthorized(buildInfrastructurePlan(manifest, exactRemoteState()), {}),
    ).not.toThrow();
  });
});

describe('CloudBase CLI output handling', () => {
  it('parses a banner-prefixed Tencent API response wrapper', () => {
    expect(
      parseCliJson('CloudBase CLI 3.6.3\n{"Response":{"Tables":[],"RequestId":"example"}}\n'),
    ).toEqual({ Tables: [], RequestId: 'example' });
  });

  it('redacts every environment id occurrence from diagnostics', () => {
    expect(redactPrivateValue('env-private failed for env-private', 'env-private')).toBe(
      '<private-environment-id> failed for <private-environment-id>',
    );
  });
});
