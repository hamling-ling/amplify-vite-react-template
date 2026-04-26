import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class AuroraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // デフォルト VPC を使用（新規 VPC 作成による CIDR 衝突を回避）
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    // DB 接続用セキュリティグループ
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Aurora Serverless v2 security group',
    });

    // ローカルマシンからのスキーマ生成用（全 IP 許可）
    // 本番運用時は特定 IP に絞ることを推奨
    dbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from anywhere (for schema generation)'
    );



    // DB 認証情報を Secrets Manager で自動生成
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: 'aurora-serverless-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dbadmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    // Aurora Serverless v2 クラスター（PostgreSQL）
    // コスト最小化:
    //   - minCapacity: 0  → アイドル時にゼロスケール（最安）
    //   - maxCapacity: 1  → 最大 1 ACU に制限
    //   - instances: 1    → リーダーなし、ライターのみ
    //   - storageEncrypted: true（デフォルト）
    //   - performanceInsight / enhancedMonitoring: 無効
    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      serverlessV2MinCapacity: 0,   // ゼロスケール（アイドル課金なし）
      serverlessV2MaxCapacity: 1,   // 最大 1 ACU
      writer: rds.ClusterInstance.serverlessV2('writer', {
        enablePerformanceInsights: false,
        publiclyAccessible: true,
      }),
      // readers なし（コスト削減）
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: 'appdb',
      storageEncrypted: true,
      deletionProtection: false,    // 開発環境向け
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Amplify の接続文字列用に出力
    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: cluster.clusterEndpoint.hostname,
      description: 'Aurora cluster endpoint hostname',
      exportName: 'AuroraClusterEndpoint',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: dbSecret.secretArn,
      description: 'Secrets Manager ARN for DB credentials',
      exportName: 'AuroraSecretArn',
    });

    new cdk.CfnOutput(this, 'DbSecurityGroupId', {
      value: dbSecurityGroup.securityGroupId,
      description: 'Security Group ID for DB access',
      exportName: 'AuroraDbSecurityGroupId',
    });
  }
}
