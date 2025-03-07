import * as fs from 'fs';
import {
  GraphqlApi,
  AuthorizationType,
  FieldLogLevel,
  MappingTemplate,
  CfnDataSource,
  Resolver,
  CfnResolver,
  AuthorizationConfig,
  Schema,
  DataSourceOptions,
  LambdaDataSource,
  ResolverProps,
  AppsyncFunction,
} from '@aws-cdk/aws-appsync';

import {
  CfnTable,
  Table,
  AttributeType,
  ProjectionType,
  BillingMode,
  StreamViewType,
  TableProps,
} from '@aws-cdk/aws-dynamodb';
import { Effect, Grant, IGrantable, PolicyStatement } from '@aws-cdk/aws-iam';
import { IFunction } from '@aws-cdk/aws-lambda';
import { Construct, NestedStack, CfnOutput, Stack } from '@aws-cdk/core';
import {
  CdkTransformerResolver,
  CdkTransformerFunctionResolver,
  CdkTransformerHttpResolver,
  CdkTransformerTable,
  SchemaTransformerOutputs, CdkTransformerFieldFunctionResolver,
} from './transformer';
import { Resource } from './transformer/resource';

import {
  SchemaTransformer,
  SchemaTransformerProps,
} from './transformer/schema-transformer';

export interface AppSyncTransformerProps {
  /**
   * Relative path to schema.graphql or a directory containing *.graphql schema files
   */
  readonly schemaPath: string;

  /**
   * Optional. {@link AuthorizationConfig} type defining authorization for AppSync GraphqlApi. Defaults to API_KEY
   * @default API_KEY authorization config
   */
  readonly authorizationConfig?: AuthorizationConfig;

  /**
   * String value representing the api name
   * @default `${id}-api`
   */
  readonly apiName?: string;

  /**
   * Whether to enable Amplify DataStore and Sync Tables
   * @default false
   */
  readonly syncEnabled?: boolean;

  /**
   * Whether to enable dynamo Point In Time Recovery. Default to false for backwards compatibility
   * @default false
   */
  readonly enableDynamoPointInTimeRecovery?: boolean;

  /**
   * Optional. {@link FieldLogLevel} type for AppSync GraphqlApi log level
   * @default FieldLogLevel.NONE
   */
  readonly fieldLogLevel?: FieldLogLevel;

  /**
   * Determines whether xray should be enabled on the AppSync API
   * @default false
   */
  readonly xrayEnabled?: boolean;

  /**
   * Determines whether to use pipeline lambdas to add {typeName, fieldName} attributes into events from
   * amplify @function directives as applied to fields.
   * @default false
   */
  readonly pipelineFieldLambdas?: boolean;

  /**
   * A map of names to specify the generated dynamo table names instead of auto generated names
   * @default undefined
   */
  readonly tableNames?: Record<string, string>;

  /**
   * A map of @model type names to stream view type
   * e.g { Blog: StreamViewType.NEW_IMAGE }
   */
  readonly dynamoDbStreamConfig?: { [name: string]: StreamViewType };

  /**
   * Specify a custom nested stack name
   * @default "appsync-nested-stack"
   */
  readonly nestedStackName?: string;

  /**
   * The root directory to use for finding custom resolvers
   * @default process.cwd()
   */
  readonly customVtlTransformerRootDirectory?: string;

  /**
   * Optional. Additonal custom transformers to run prior to the CDK resource generations.
   * Particularly useful for custom directives.
   * These should extend Transformer class from graphql-transformer-core
   * @default undefined
   */

  readonly preCdkTransformers?: any[];

  /**
   * Optional. Additonal custom transformers to run after the CDK resource generations.
   * Mostly useful for deep level customization of the generated CDK CloudFormation resources.
   * These should extend Transformer class from graphql-transformer-core
   * @default undefined
   */

  readonly postCdkTransformers?: any[];


  /**
   * Optional. An override of the set of transformers passed into GraphQLTransform. Used for deep customization of amplify
   * transformers, or for when amplify has made breaking changes to its schema but this package hasn't upgraded yet.
   * @default undefined
   */
  readonly amplifyTransformers?: any[];

  /**
   * Optional. An override of the transformConfig argument to GraphQLTransform. Generally used to specify the
   * schema Version parameter
   * e.g { Version: 5 }
   * @default undefined
   */
  readonly transformConfig?: any;

  /**
   * Optional. An override of the featureFlags argument to GraphQLTransform.
   * e.g { getBoolean: (k) => k !== 'improvePluralisation' }
  * @default undefined
   */
  readonly featureFlags?: any;
}

const defaultAuthorizationConfig: AuthorizationConfig = {
  defaultAuthorization: {
    authorizationType: AuthorizationType.API_KEY,
    apiKeyConfig: {
      description: 'Auto generated API Key from construct',
      name: 'dev',
    },
  },
};

/**
 * AppSyncTransformer Construct
 */
export class AppSyncTransformer extends Construct {
  /**
   * The cdk GraphqlApi construct
   */
  public readonly appsyncAPI: GraphqlApi;

  /**
   * The NestedStack that contains the AppSync resources
   */
  public readonly nestedAppsyncStack: NestedStack;

  /**
   * Map of cdk table tokens to table names
   */
  public readonly tableNameMap: { [name: string]: string };

  /**
   * Map of cdk table keys to L2 Table
   * e.g. { 'TaskTable': Table }
   */
  public readonly tableMap: { [name: string]: Table };

  /**
   * The outputs from the SchemaTransformer
   */
  public readonly outputs: SchemaTransformerOutputs;

  /**
   * The AppSync resolvers from the transformer minus any function resolvers
   */
  public readonly resolvers: { [name: string]: CdkTransformerResolver };

  /**
   * The Lambda Function resolvers designated by the function directive
   * https://github.com/kcwinner/cdk-appsync-transformer#functions
   */
  public readonly functionResolvers: {
    [name: string]: CdkTransformerFunctionResolver[];
  };

  public readonly httpResolvers: {
    [name: string]: CdkTransformerHttpResolver[];
  };

  public readonly fieldResolvers: {
    [name: string]: Resolver[];
  };

  public readonly lambdaFieldResolvers: {
    [name: string]: CdkTransformerFieldFunctionResolver;
  };

  private props: AppSyncTransformerProps
  private isSyncEnabled: boolean;
  private arePipelineLambdasEnabled: boolean;
  private syncTable: Table | undefined;
  private pointInTimeRecovery: boolean;
  private readonly publicResourceArns: string[];
  private readonly privateResourceArns: string[];

  constructor(scope: Construct, id: string, props: AppSyncTransformerProps) {
    super(scope, id);

    this.props = props;
    this.tableMap = {};
    this.fieldResolvers = {};
    this.isSyncEnabled = props.syncEnabled ? props.syncEnabled : false;
    this.arePipelineLambdasEnabled = props.pipelineFieldLambdas ?? false;
    this.pointInTimeRecovery = props.enableDynamoPointInTimeRecovery ?? false;

    const transformerConfiguration: SchemaTransformerProps = {
      schemaPath: props.schemaPath,
      syncEnabled: props.syncEnabled ?? false,
      customVtlTransformerRootDirectory: props.customVtlTransformerRootDirectory,
      amplifyTransformers: props.amplifyTransformers,
      transformConfig: props.transformConfig,
      featureFlags: props.featureFlags,
    };

    // Combine the arrays so we only loop once
    // Test each transformer to see if it implements ITransformer
    const allCustomTransformers = [...props.amplifyTransformers ?? [], ...props.preCdkTransformers ?? [], ...props.postCdkTransformers ?? []];
    if (allCustomTransformers && allCustomTransformers.length > 0) {
      allCustomTransformers.forEach(transformer => {
        if (transformer && !this.implementsITransformer(transformer)) {
          throw new Error(`Transformer does not implement ITransformer from graphql-transformer-core: ${transformer}`);
        }
      });
    }

    const transformer = new SchemaTransformer(transformerConfiguration);
    this.outputs = transformer.transform(props.preCdkTransformers, props.postCdkTransformers);
    const resolvers = transformer.getResolvers();

    this.functionResolvers = this.outputs.functionResolvers ?? {};

    // Remove any function resolvers from the total list of resolvers
    // Otherwise it will add them twice
    for (const [_, functionResolvers] of Object.entries(
      this.functionResolvers,
    )) {
      functionResolvers.forEach((resolver) => {
        switch (resolver.typeName) {
          case 'Query':
          case 'Mutation':
          case 'Subscription':
            delete resolvers[resolver.fieldName];
            break;
        }
      });
    }
    this.lambdaFieldResolvers = resolvers.lambdaFieldResolvers ?? {};

    this.httpResolvers = this.outputs.httpResolvers ?? {};

    // Remove any http resolvers from the total list of resolvers
    // Otherwise it will add them twice
    for (const [_, httpResolvers] of Object.entries(this.httpResolvers)) {
      httpResolvers.forEach((resolver) => {
        switch (resolver.typeName) {
          case 'Query':
          case 'Mutation':
          case 'Subscription':
            delete resolvers[resolver.fieldName];
            break;
        }
      });
    }

    this.resolvers = resolvers;

    this.nestedAppsyncStack = new NestedStack(this, props.nestedStackName ?? 'appsync-nested-stack');

    // AppSync
    this.appsyncAPI = new GraphqlApi(this.nestedAppsyncStack, `${id}-api`, {
      name: props.apiName ? props.apiName : `${id}-api`,
      authorizationConfig: props.authorizationConfig
        ? props.authorizationConfig
        : defaultAuthorizationConfig,
      logConfig: {
        fieldLogLevel: props.fieldLogLevel
          ? props.fieldLogLevel
          : FieldLogLevel.NONE,
      },
      schema: Schema.fromAsset('./appsync/schema.graphql'),
      xrayEnabled: props.xrayEnabled ?? false,
    });

    let tableData = this.outputs.cdkTables ?? {};

    // Check to see if sync is enabled
    if (tableData.DataStore) {
      this.isSyncEnabled = true;
      this.syncTable = this.createSyncTable(tableData.DataStore);
      delete tableData.DataStore; // We don't want to create this again below so remove it from the tableData map
    }

    this.tableNameMap = this.createTablesAndResolvers(tableData, resolvers, props.tableNames);
    if (this.outputs.noneResolvers) {
      this.createNoneDataSourceAndResolvers(
        this.outputs.noneResolvers,
        resolvers,
      );
    }
    this.createHttpResolvers();

    this.publicResourceArns = this.getResourcesFromGeneratedRolePolicy(transformer.unauthRolePolicy);
    this.privateResourceArns = this.getResourcesFromGeneratedRolePolicy(transformer.authRolePolicy);

    // Outputs so we can generate exports
    new CfnOutput(scope, 'appsyncGraphQLEndpointOutput', {
      value: this.appsyncAPI.graphqlUrl,
      description: 'Output for aws_appsync_graphqlEndpoint',
    });
  }

  /**
   * graphql-transformer-core needs to be jsii enabled to pull the ITransformer interface correctly.
   * Since it's not in peer dependencies it doesn't show up in the jsii deps list.
   * Since it's not jsii enabled it has to be bundled.
   * The package can't be in BOTH peer and bundled dependencies
   * So we do a fake test to make sure it implements these and hope for the best
   * @param transformer
   */
  private implementsITransformer(transformer: any) {
    return 'name' in transformer
      && 'directive' in transformer
      && 'typeDefinitions' in transformer;
  }

  /**
   * Creates NONE data source and associated resolvers
   * @param noneResolvers The resolvers that belong to the none data source
   * @param resolvers The resolver map minus function resolvers
   */
  private createNoneDataSourceAndResolvers(
    noneResolvers: { [name: string]: CdkTransformerResolver },
    resolvers: any,
  ) {
    const noneDataSource = this.appsyncAPI.addNoneDataSource('NONE');

    Object.keys(noneResolvers).forEach((resolverKey) => {
      const resolver = resolvers[resolverKey];
      this.createResolver(
        this.nestedAppsyncStack,
        `${resolver.typeName}-${resolver.fieldName}-resolver`,
        {
          api: this.appsyncAPI,
          typeName: resolver.typeName,
          fieldName: resolver.fieldName,
          dataSource: noneDataSource,
          requestMappingTemplate: MappingTemplate.fromFile(
            resolver.requestMappingTemplate,
          ),
          responseMappingTemplate: MappingTemplate.fromFile(
            resolver.responseMappingTemplate,
          ),
        },
      );
    });
  }

  /**
   * Creates each dynamodb table, gsis, dynamodb datasource, and associated resolvers
   * If sync is enabled then TTL configuration is added
   * Returns tableName: table map in case it is needed for lambda functions, etc
   * @param tableData The CdkTransformer table information
   * @param resolvers The resolver map minus function resolvers
   */
  private createTablesAndResolvers(
    tableData: { [name: string]: CdkTransformerTable },
    resolvers: any,
    tableNames: Record<string, string> = {},
  ): { [name: string]: string } {
    const tableNameMap: any = {};

    Object.keys(tableData).forEach((tableKey) => {
      const tableName = tableNames[tableKey] ?? undefined;
      const table = this.createTable(tableData[tableKey], tableName);
      this.tableMap[tableKey] = table;

      const dataSource = this.appsyncAPI.addDynamoDbDataSource(tableKey, table);

      // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-appsync-datasource-deltasyncconfig.html

      if (this.isSyncEnabled && this.syncTable) {
        //@ts-ignore - ds is the base CfnDataSource and the db config needs to be versioned - see CfnDataSource
        dataSource.ds.dynamoDbConfig.versioned = true;

        //@ts-ignore - ds is the base CfnDataSource - see CfnDataSource
        dataSource.ds.dynamoDbConfig.deltaSyncConfig = {
          baseTableTtl: '43200', // Got this value from amplify - 30 days in minutes
          deltaSyncTableName: this.syncTable.tableName,
          deltaSyncTableTtl: '30', // Got this value from amplify - 30 minutes
        };

        // Need to add permission for our datasource service role to access the sync table
        dataSource.grantPrincipal.addToPolicy(
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
              'dynamodb:*', // TODO: This may be too permissive
            ],
            resources: [this.syncTable.tableArn],
          }),
        );
      }

      const dynamoDbConfig = dataSource.ds
        .dynamoDbConfig as CfnDataSource.DynamoDBConfigProperty;
      tableNameMap[tableKey] = dynamoDbConfig.tableName;

      // Loop the basic resolvers
      tableData[tableKey].resolvers.forEach((resolverKey) => {
        const resolver = resolvers[resolverKey];
        this.createResolver(
          this.nestedAppsyncStack,
          `${resolver.typeName}-${resolver.fieldName}-resolver`,
          {
            api: this.appsyncAPI,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            dataSource: dataSource,
            requestMappingTemplate: MappingTemplate.fromFile(
              resolver.requestMappingTemplate,
            ),
            responseMappingTemplate: MappingTemplate.fromFile(
              resolver.responseMappingTemplate,
            ),
          },
        );
      });

      // Loop the gsi resolvers
      tableData[tableKey].gsiResolvers.forEach((resolverKey) => {
        const resolver = resolvers.gsi[resolverKey];
        this.createResolver(
          this.nestedAppsyncStack,
          `${resolver.typeName}-${resolver.fieldName}-resolver`,
          {
            api: this.appsyncAPI,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            dataSource: dataSource,
            requestMappingTemplate: MappingTemplate.fromFile(
              resolver.requestMappingTemplate,
            ),
            responseMappingTemplate: MappingTemplate.fromFile(
              resolver.responseMappingTemplate,
            ),
          },
        );
      });
    });

    return tableNameMap;
  }

  private createTable(tableData: CdkTransformerTable, tableName?: string) {
    // I do not want to force people to pass `TypeTable` - this way they are only passing the @model Type name
    const modelTypeName = tableData.tableName.replace('Table', '');
    const streamSpecification = this.props.dynamoDbStreamConfig && this.props.dynamoDbStreamConfig[modelTypeName];
    const tableProps: TableProps = {
      tableName,
      billingMode: BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: tableData.partitionKey.name,
        type: this.convertAttributeType(tableData.partitionKey.type),
      },
      pointInTimeRecovery: this.pointInTimeRecovery,
      sortKey: tableData.sortKey && tableData.sortKey.name
        ? {
          name: tableData.sortKey.name,
          type: this.convertAttributeType(tableData.sortKey.type),
        } : undefined,
      timeToLiveAttribute: tableData?.ttl?.enabled ? tableData.ttl.attributeName : undefined,
      stream: streamSpecification,
    };

    const table = new Table(
      this.nestedAppsyncStack,
      tableData.tableName,
      tableProps,
    );

    tableData.localSecondaryIndexes.forEach((lsi) => {
      table.addLocalSecondaryIndex({
        indexName: lsi.indexName,
        sortKey: {
          name: lsi.sortKey.name,
          type: this.convertAttributeType(lsi.sortKey.type),
        },
        projectionType: this.convertProjectionType(
          lsi.projection.ProjectionType,
        ),
      });
    });

    tableData.globalSecondaryIndexes.forEach((gsi) => {
      table.addGlobalSecondaryIndex({
        indexName: gsi.indexName,
        partitionKey: {
          name: gsi.partitionKey.name,
          type: this.convertAttributeType(gsi.partitionKey.type),
        },
        sortKey: gsi.sortKey && gsi.sortKey.name
          ? {
            name: gsi.sortKey.name,
            type: this.convertAttributeType(gsi.sortKey.type),
          } : undefined,
        projectionType: this.convertProjectionType(
          gsi.projection.ProjectionType,
        ),
      });
    });

    return table;
  }

  /**
   * Creates the sync table for Amplify DataStore
   * https://docs.aws.amazon.com/appsync/latest/devguide/conflict-detection-and-sync.html
   * @param tableData The CdkTransformer table information
   */
  private createSyncTable(tableData: CdkTransformerTable): Table {
    return new Table(this, 'appsync-api-sync-table', {
      billingMode: BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: tableData.partitionKey.name,
        type: this.convertAttributeType(tableData.partitionKey.type),
      },
      sortKey: {
        name: tableData.sortKey!.name, // We know it has a sortkey because we forced it to
        type: this.convertAttributeType(tableData.sortKey!.type), // We know it has a sortkey because we forced it to
      },
      timeToLiveAttribute: tableData.ttl?.attributeName || '_ttl',
    });
  }

  private convertAttributeType(type: string): AttributeType {
    switch (type) {
      case 'N':
        return AttributeType.NUMBER;
      case 'B':
        return AttributeType.BINARY;
      case 'S': // Same as default
      default:
        return AttributeType.STRING;
    }
  }

  private convertProjectionType(type: string): ProjectionType {
    switch (type) {
      case 'INCLUDE':
        return ProjectionType.INCLUDE;
      case 'KEYS_ONLY':
        return ProjectionType.KEYS_ONLY;
      case 'ALL': // Same as default
      default:
        return ProjectionType.ALL;
    }
  }

  private createHttpResolvers() {
    for (const [endpoint, httpResolvers] of Object.entries(
      this.httpResolvers,
    )) {
      const strippedEndpoint = endpoint.replace(/[^_0-9A-Za-z]/g, '');
      const httpDataSource = this.appsyncAPI.addHttpDataSource(
        `${strippedEndpoint}`,
        endpoint,
      );

      httpResolvers.forEach((resolver: CdkTransformerHttpResolver) => {
        this.createResolver(
          this.nestedAppsyncStack,
          `${resolver.typeName}-${resolver.fieldName}-resolver`,
          {
            api: this.appsyncAPI,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            dataSource: httpDataSource,
            requestMappingTemplate: MappingTemplate.fromString(
              resolver.defaultRequestMappingTemplate,
            ),
            responseMappingTemplate: MappingTemplate.fromString(
              resolver.defaultResponseMappingTemplate,
            ),
          },
        );
      });
    }
  }

  /**
   * This takes one of the autogenerated policies from AWS and builds the list of ARNs for granting GraphQL access later
   * @param policy The auto generated policy from the AppSync Transformers
   * @returns An array of resource arns for use with grants
   */
  private getResourcesFromGeneratedRolePolicy(policy?: Resource): string[] {
    if (!policy?.Properties?.PolicyDocument?.Statement) return [];

    const { region, account } = this.nestedAppsyncStack;

    const resolvedResources: string[] = [];
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const { Resource: resources = [] } = statement ?? {};
      for (const resource of resources) {
        const subs = resource['Fn::Sub'][1];
        const { typeName, fieldName } = subs ?? {};
        if (fieldName) {
          resolvedResources.push(`arn:aws:appsync:${region}:${account}:apis/${this.appsyncAPI.apiId}/types/${typeName}/fields/${fieldName}`);
        } else {
          resolvedResources.push(`arn:aws:appsync:${region}:${account}:apis/${this.appsyncAPI.apiId}/types/${typeName}/*`);
        }
      }
    }

    return resolvedResources;
  }

  /**
   * Adds the function as a lambdaDataSource to the AppSync api
   * Adds all of the functions resolvers to the AppSync api
   * @param functionName The function name specified in the @function directive of the schema
   * @param id The id to give
   * @param lambdaFunction The lambda function to attach
   * @param options
   */
  public addLambdaDataSourceAndResolvers(
    functionName: string,
    id: string,
    lambdaFunction: IFunction,
    options?: DataSourceOptions,
  ): LambdaDataSource {
    const functionDataSource = this.appsyncAPI.addLambdaDataSource(
      id,
      lambdaFunction,
      options,
    );

    for (const resolver of this.functionResolvers[functionName]) {
      const maybeCustomResolver = this.lambdaFieldResolvers[`${resolver.typeName}${resolver.fieldName}`];

      const requestMappingTemplate = MappingTemplate.fromString(resolver.defaultRequestMappingTemplate);
      const responseMappingTemplate = MappingTemplate.fromString(resolver.defaultResponseMappingTemplate);

      if (maybeCustomResolver && this.arePipelineLambdasEnabled) {
        const pipelineFunction = new AppsyncFunction(this.nestedAppsyncStack, `${resolver.typeName}-${resolver.fieldName}-pipeline-resolver`, {
          api: this.appsyncAPI,
          name: `${resolver.typeName}_${resolver.fieldName}_pipeline_resolver`,
          dataSource: functionDataSource,
          requestMappingTemplate: MappingTemplate.fromString(`
## [Start] Invoke AWS Lambda data source: ${resolver.typeName}_${resolver.fieldName}_pipeline_resolver. **
{
  "version": "2018-05-29",
  "operation": "Invoke",
  "payload": {
      "typeName": "$ctx.stash.get("typeName")",
      "fieldName": "$ctx.stash.get("fieldName")",
      "arguments": $util.toJson($ctx.arguments),
      "identity": $util.toJson($ctx.identity),
      "source": $util.toJson($ctx.source),
      "request": $util.toJson($ctx.request),
      "prev": $util.toJson($ctx.prev)
  }
}
## [End] Invoke AWS Lambda data source: ${resolver.typeName}_${resolver.fieldName}_pipeline_resolver. **`),
          responseMappingTemplate,
        });

        this.createResolver(
          this.nestedAppsyncStack,
          `${resolver.typeName}-${resolver.fieldName}-resolver`,
          {
            api: this.appsyncAPI,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            pipelineConfig: [pipelineFunction],
            requestMappingTemplate: MappingTemplate.fromFile(maybeCustomResolver.requestMappingTemplate),
            responseMappingTemplate: MappingTemplate.fromFile(maybeCustomResolver.responseMappingTemplate),
          },
        );
      } else {

        this.createResolver(
          this.nestedAppsyncStack,
          `${resolver.typeName}-${resolver.fieldName}-resolver`,
          {
            api: this.appsyncAPI,
            typeName: resolver.typeName,
            fieldName: resolver.fieldName,
            dataSource: functionDataSource,
            requestMappingTemplate,
            responseMappingTemplate, // This defaults to allow errors to return to the client instead of throwing
          },
        );
      }
    }

    return functionDataSource;
  }

  /**
   * Adds a stream to the dynamodb table associated with the type
   * @param props
   * @returns string - the stream arn token
   */
  public addDynamoDBStream(props: DynamoDBStreamProps): string {
    const tableName = `${props.modelTypeName}Table`;
    const table = this.tableMap[tableName];
    if (!table) throw new Error(`Table with name '${tableName}' not found.`);

    const cfnTable = table.node.defaultChild as CfnTable;
    cfnTable.streamSpecification = {
      streamViewType: props.streamViewType,
    };

    return cfnTable.attrStreamArn;
  }

  /**
   * Allows for overriding the generated request and response mapping templates
   * @param props
   */
  public overrideResolver(props: OverrideResolverProps) {
    const resolver = this.nestedAppsyncStack.node.tryFindChild(`${props.typeName}-${props.fieldName}-resolver`) as Resolver;
    if (!resolver) throw new Error(`Resolver with typeName '${props.typeName}' and fieldName '${props.fieldName}' not found`);

    const cfnResolver = resolver.node.defaultChild as CfnResolver;
    if (!cfnResolver) throw new Error(`Resolver with typeName '${props.typeName}' and fieldName '${props.fieldName}' not found`);

    if (props.requestMappingTemplateFile) {
      cfnResolver.requestMappingTemplate = fs.readFileSync(props.requestMappingTemplateFile).toString('utf-8');
    }

    if (props.responseMappingTemplateFile) {
      cfnResolver.responseMappingTemplate = fs.readFileSync(props.responseMappingTemplateFile).toString('utf-8');
    }
  }

  /**
   * Adds an IAM policy statement granting access to the public fields of
   * the AppSync API. Policy is based off of the @auth transformer
   * https://docs.amplify.aws/cli/graphql-transformer/auth
   * @param grantee The principal to grant access to
   */
  public grantPublic(grantee: IGrantable): Grant {
    return Grant.addToPrincipal({
      grantee,
      actions: ['appsync:GraphQL'],
      resourceArns: this.publicResourceArns,
      scope: this,
    });
  }

  /**
   * Adds an IAM policy statement granting access to the private fields of
   * the AppSync API. Policy is based off of the @auth transformer
   * https://docs.amplify.aws/cli/graphql-transformer/auth
   * @param grantee
   */
  public grantPrivate(grantee: IGrantable): Grant {
    return Grant.addToPrincipal({
      grantee,
      actions: ['appsync:GraphQL'],
      resourceArns: this.privateResourceArns,
    });
  }

  /**
   * This creates a resolver, and pushes it to fieldResolvers
   * @returns resolver
   * @param stack cdk.Stack
   * @param id resource id
   * @param props ResolverProps
   */
  private createResolver(stack: Stack, id: string, props: ResolverProps): Resolver {
    const resolver = new Resolver(
      stack,
      id,
      props,
    );

    const fieldName = props.fieldName;
    if (!(fieldName in this.fieldResolvers)) {
      this.fieldResolvers[fieldName] = [];
    }
    this.fieldResolvers[fieldName].push(resolver);
    return resolver;
  }
}

export interface DynamoDBStreamProps {
  /**
   * The @model type name from the graph schema
   * e.g. Blog
   */
  readonly modelTypeName: string;
  readonly streamViewType: StreamViewType;
}

export interface OverrideResolverProps {
  /**
   * Example: Query, Mutation, Subscription
   * For a GSI this might be Post, Comment, etc
   */
  readonly typeName: string;

  /**
   * The fieldname to override e.g. listThings, createStuff
   */
  readonly fieldName: string;

  /**
   * The full path to the request mapping template file
   */
  readonly requestMappingTemplateFile?: string;

  /**
   * The full path to the resposne mapping template file
   */
  readonly responseMappingTemplateFile?: string;
}