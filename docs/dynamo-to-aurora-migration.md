# DynamoDB から Aurora Serverless v2 への移行手順

Amplify Gen2 + Vite React テンプレートの DB を DynamoDB から Aurora Serverless v2 (PostgreSQL) に移行する手順。

---

## 前提条件

- AWS CLI が設定済みであること
- Node.js 20 以上
- `psql` クライアント（`sudo apt install postgresql-client`）

---

## Step 1: CDK で Aurora Serverless v2 をデプロイする

### 1-1. CDK プロジェクトのセットアップ

```bash
mkdir cdk && cd cdk
```

`cdk/package.json`:

```json
{
  "name": "aurora-cdk",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "cdk": "cdk"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.100.0",
    "constructs": "^10.0.0"
  },
  "devDependencies": {
    "aws-cdk": "^2.100.0",
    "typescript": "~5.9.3",
    "@types/node": "^20.0.0"
  }
}
```

`cdk/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["lib/**/*.ts", "bin/**/*.ts"]
}
```

`cdk/cdk.json`:

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/app.ts"
}
```

### 1-2. CDK スタックの作成

`cdk/bin/app.ts`:

```typescript
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AuroraStack } from '../lib/aurora-stack';

const app = new cdk.App();

new AuroraStack(app, 'AuroraStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

`cdk/lib/aurora-stack.ts`:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class AuroraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // デフォルト VPC を使用（CIDR 衝突を回避）
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Aurora Serverless v2 security group',
    });

    // ローカルおよび Amplify SQL Lambda（VPC 外）からの接続を許可
    dbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from anywhere'
    );

    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: 'aurora-serverless-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dbadmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      serverlessV2MinCapacity: 0,  // アイドル時ゼロスケール
      serverlessV2MaxCapacity: 1,  // 最大 1 ACU
      writer: rds.ClusterInstance.serverlessV2('writer', {
        enablePerformanceInsights: false,
        publiclyAccessible: true,  // VPC 外の Lambda から接続するために必要
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: 'appdb',
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: cluster.clusterEndpoint.hostname,
      exportName: 'AuroraClusterEndpoint',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: dbSecret.secretArn,
      exportName: 'AuroraSecretArn',
    });
  }
}
```

### 1-3. デプロイ

```bash
cd cdk
npm install
npx cdk bootstrap  # 初回のみ
npx cdk deploy
```

デプロイ完了後、出力された `ClusterEndpoint` と `SecretArn` を控えておく。

---

## Step 2: Aurora にテーブルを作成する

### 2-1. パスワードを取得

```bash
aws secretsmanager get-secret-value \
  --secret-id <SecretArn> \
  --query SecretString \
  --output text
```

出力 JSON の `password` フィールドの値を使う。

### 2-2. psql で接続してテーブルを作成

```bash
psql -h <ClusterEndpoint> -U dbadmin -d appdb
```

```sql
CREATE TABLE todo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Step 3: Amplify に接続文字列を登録する

```bash
npx ampx sandbox secret set SQL_CONNECTION_STRING
```

入力値:

```
postgres://dbadmin:<password>@<ClusterEndpoint>:5432/appdb
```

---

## Step 4: Amplify のスキーマを生成する

```bash
npx ampx generate schema-from-database \
  --connection-uri-secret SQL_CONNECTION_STRING \
  --out amplify/data/schema.sql.ts
```

生成された `amplify/data/schema.sql.ts` の `vpcConfig` ブロックを削除する。
（Amplify SQL Lambda を VPC 外で動かすことで、VPC エンドポイント不要になりコストを削減できる）

また、`.schema()` 内の `todo` モデルに認可ルールを追加する:

```typescript
"todo": a.model({
    id: a.id().required(),
    content: a.string(),
    created_at: a.string(),
    updated_at: a.string()
}).identifier(["id"])
 .authorization((allow) => [allow.authenticated()])
```

---

## Step 5: amplify/data/resource.ts を更新する

DynamoDB 版のスキーマ定義を削除し、Aurora 版に切り替える。

```typescript
import { type ClientSchema, defineData } from "@aws-amplify/backend";
import { schema } from "./schema.sql";

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
```

---

## Step 6: フロントエンドのモデル参照を更新する

`src/App.tsx` のモデル名を `Todo`（DynamoDB版）から `todo`（Aurora版）に変更する。

```typescript
// Before
client.models.Todo.observeQuery()
client.models.Todo.create(...)
client.models.Todo.delete(...)

// After
client.models.todo.observeQuery()
client.models.todo.create(...)
client.models.todo.delete(...)
```

型定義も同様に変更:

```typescript
// Before
useState<Array<Schema["Todo"]["type"]>>([])

// After
useState<Array<Schema["todo"]["type"]>>([])
```

---

## Step 7: sandbox を再起動してデプロイ

```bash
npx ampx sandbox delete
npx ampx sandbox
```

`amplify_outputs.json` が更新され、`model_introspection` に `todo`（Aurora版）が反映されたことを確認する。

---

## トラブルシューティング

### `KnexTimeoutError` が出る場合

Aurora が VPC の isolated subnet にあり、ローカルから接続できない。CDK の subnet を `PUBLIC` に変更して `publiclyAccessible: true` を設定する。

### `DatabaseSchemaError: Imported SQL schema is empty` が出る場合

Aurora に接続はできているがテーブルが存在しない。Step 2 のテーブル作成を実施する。

### `Unable to retrieve secret for database connection from SSM` が出る場合

Amplify SQL Lambda が VPC 内で動いており SSM に到達できない。`schema.sql.ts` から `vpcConfig` ブロックを削除して Lambda を VPC 外で動かす。

### `Resource already exists` で sandbox のデプロイが失敗する場合

古い AppSync リゾルバーが残っている。`npx ampx sandbox delete` で一度クリアしてから再実行する。
