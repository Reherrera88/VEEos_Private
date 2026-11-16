import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { instanceManager } from '../manager/instance-manager.js';
import { logger } from '../utils/logger.js';
import { VEEosError, ErrorCodes, isBlockingError } from '../utils/errors.js';
import * as flowTools from '../tools/flow-tools.js';

const TOOL_DEFINITIONS = [
  // Pool management
  {
    name: 'veeos_status',
    description: 'Get status of all Google Flow accounts in the pool',
    inputSchema: {
      type: 'object',
      properties: {
        detailed: { type: 'boolean', description: 'Include detailed queue and health info', default: false },
      },
    },
  },
  {
    name: 'veeos_accounts',
    description: 'List all configured accounts with their credits and status',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'veeos_start_account',
    description: 'Start/connect a specific account',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Account ID to start' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'veeos_health_check',
    description: 'Run health check on all or specific account',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Optional specific account ID' },
      },
    },
  },
  
  // Image Generation
  {
    name: 'veeos_generate_image',
    description: 'Generate image using best available account. Set auto_confirm=true to actually generate (consumes credits).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text prompt for image generation' },
        model: { type: 'string', description: 'Model: Nano Banana Pro, Nano Banana 2, Imagen 4', default: 'Nano Banana 2' },
        ratio: { type: 'string', description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4', default: '1:1' },
        auto_confirm: { type: 'boolean', description: 'Actually generate (consumes credits). Default: false (prepare only)', default: false },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images' },
        brand: { type: 'string', description: 'Brand context for model selection: premium, standard' },
        priority: { type: 'string', description: 'Job priority: high, normal, low', default: 'normal' },
        preferred_account: { type: 'string', description: 'Preferred account ID (optional)' },
      },
      required: ['prompt'],
    },
  },
  
  // Video Generation
  {
    name: 'veeos_generate_video',
    description: 'Configure video generation (stops before Generate - no credits consumed). Use account tools to confirm manually.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text prompt for video generation' },
        model: { type: 'string', description: 'Model: Omni Flash, Veo 3.1 - Lite/Fast/Quality', default: 'Omni Flash' },
        ratio: { type: 'string', description: 'Aspect ratio: 16:9, 9:16, 1:1', default: '16:9' },
        duration: { type: 'number', description: 'Duration in seconds', default: 5 },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images' },
        priority: { type: 'string', description: 'Job priority', default: 'normal' },
        preferred_account: { type: 'string', description: 'Preferred account ID (optional)' },
      },
      required: ['prompt'],
    },
  },
  
  // Characters
  {
    name: 'veeos_create_character',
    description: 'Create a character in Google Flow',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Character name' },
        description: { type: 'string', description: 'Character description/prompt' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Reference image paths' },
        priority: { type: 'string', default: 'normal' },
        preferred_account: { type: 'string' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'veeos_import_character',
    description: 'Import character from JSON file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to character JSON file' },
        preferred_account: { type: 'string' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'veeos_list_characters',
    description: 'List all characters in an account',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Specific account (optional, uses best available)' },
      },
    },
  },
  
  // Scenes
  {
    name: 'veeos_create_scene',
    description: 'Create a scene with characters',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Scene description' },
        characters: { type: 'array', items: { type: 'string' }, description: 'Character names to include' },
        priority: { type: 'string', default: 'normal' },
        preferred_account: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  
  // Grid Architect
  {
    name: 'veeos_grid_architect',
    description: 'Configure Grid Architect for batch shot generation',
    inputSchema: {
      type: 'object',
      properties: {
        theme_prompt: { type: 'string', description: 'Overall theme prompt' },
        shot_prompts: { type: 'array', items: { type: 'string' }, description: 'Individual shot prompts' },
        engine: { type: 'string', description: 'Engine/model', default: 'Nano Banana 2' },
        ratio: { type: 'string', description: 'Aspect ratio', default: '16:9' },
        visual_logic: { type: 'string', description: 'Visual logic type' },
        references: { type: 'array', items: { type: 'string' }, description: 'Reference images' },
        priority: { type: 'string', default: 'normal' },
        preferred_account: { type: 'string' },
      },
      required: ['theme_prompt'],
    },
  },
  
  // Generic tool
  {
    name: 'veeos_use_tool',
    description: 'Open and configure any Flow tool by name',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Tool name (e.g., Grid Architect, Image Generation)' },
        params: { type: 'object', description: 'Tool configuration parameters' },
        priority: { type: 'string', default: 'normal' },
        preferred_account: { type: 'string' },
      },
      required: ['tool_name'],
    },
  },
  
  // Download
  {
    name: 'veeos_download_latest',
    description: 'Download most recent generated file from an account',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Account ID' },
      },
      required: ['account_id'],
    },
  },
  
  // Queue management
  {
    name: 'veeos_queue_status',
    description: 'Get job queue status for all or specific account',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Optional specific account' },
        history_limit: { type: 'number', description: 'History entries to return', default: 10 },
      },
    },
  },
];

async function handleToolCall(name, args) {
  logger.info('MCP tool called', { tool: name, args: JSON.stringify(args).substring(0, 200) });
  
  try {
    switch (name) {
      // Pool management
      case 'veeos_status': {
        const status = instanceManager.getStatus();
        if (args.detailed) {
          // Add queue details
          for (const acc of status.accounts) {
            const instance = instanceManager.instances.get(acc.id);
            if (instance) {
              acc.queueDetails = instance.queue.getStatus();
              acc.healthFailures = instance.account.healthFailures;
            }
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      }
      
      case 'veeos_accounts': {
        const accounts = Array.from(instanceManager.instances.values()).map(i => ({
          id: i.account.id,
          email: i.account.email,
          credits: i.account.credits,
          priority: i.account.priority,
          status: i.status,
          enabled: i.account.enabled,
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ accounts }, null, 2) }] };
      }
      
      case 'veeos_start_account': {
        await instanceManager.startAccount(args.account_id);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'started', account_id: args.account_id }) }] };
      }
      
      case 'veeos_health_check': {
        const results = await instanceManager.healthCheck(args.account_id);
        return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
      }
      
      // Image Generation
      case 'veeos_generate_image': {
        const requiredCredits = instanceManager.estimateCredits('generate_image', args);
        let accountId = args.preferred_account;
        
        if (!accountId) {
          const bestAccount = await instanceManager.getBestAccount(requiredCredits);
          accountId = bestAccount.id;
        }
        
        const { job, instance } = await instanceManager.executeJob(accountId, 'generate_image', args, {
          creditsCost: requiredCredits,
          priority: args.priority,
        });
        
        try {
          const result = await flowTools.generateImage(accountId, args);
          await instanceManager.completeJob(accountId, job.id, result);
          return { content: [{ type: 'text', text: JSON.stringify({ jobId: job.id, accountId, ...result }, null, 2) }] };
        } catch (error) {
          await instanceManager.failJob(accountId, job.id, error);
          throw error;
        }
      }
      
      // Video Generation
      case 'veeos_generate_video': {
        const requiredCredits = instanceManager.estimateCredits('generate_video', args);
        let accountId = args.preferred_account;
        
        if (!accountId) {
          const bestAccount = await instanceManager.getBestAccount(requiredCredits);
          accountId = bestAccount.id;
        }
        
        const { job, instance } = await instanceManager.executeJob(accountId, 'generate_video', args, {
          creditsCost: requiredCredits,
          priority: args.priority,
        });
        
        try {
          const result = await flowTools.generateVideo(accountId, args);
          await instanceManager.completeJob(accountId, job.id, result);
          return { content: [{ type: 'text', text: JSON.stringify({ jobId: job.id, accountId, ...result }, null, 2) }] };
        } catch (error) {
          await instanceManager.failJob(accountId, job.id, error);
          throw error;
        }
      }
      
      // Characters
      case 'veeos_create_character': {
        const requiredCredits = instanceManager.estimateCredits('create_character', args);
        let accountId = args.preferred_account;
        
        if (!accountId) {
          const bestAccount = await instanceManager.getBestAccount(requiredCredits);
          accountId = bestAccount.id;
        }
        
        const { job } = await instanceManager.executeJob(accountId, 'create_character', args, {
          creditsCost: requiredCredits,
          priority: args.priority,
        });
        
        try {
          const result = await flowTools.createCharacter(accountId, args);
          await instanceManager.completeJob(accountId, job.id, result);
          return { content: [{ type: 'text', text: JSON.stringify({ jobId: job.id, accountId, ...result }, null, 2) }] };
        } catch (error) {
          await instanceManager.failJob(accountId, job.id, error);
          throw error;
        }
      }
      
      case 'veeos_import_character': {
        let accountId = args.preferred_account;
        if (!accountId) {
          const bestAccount = await instanceManager.getBestAccount(5);
          accountId = bestAccount.id;
        }
        
        const { job } = await instanceManager.executeJob(accountId, 'import_character', args, {
          creditsCost: 5,
          priority: args.priority,
        });
        
        try {
          const result = await flowTools.importCharacter(accountId, args);
          await instanceManager.completeJob(accountId, job.id, result);
          return { content: [{ type: 'text', text: JSON.stringify({ jobId: job.id, accountId, ...result }, null, 2) }] };
        } catch (error) {
          await instanceManager.failJob(accountId, job.id, error);
          throw error;
        }
      }
      
      case 'veeos_list_characters': {
        let accountId = args.account_id;
        if (!accountId) {
          const accounts = instanceManager.getAvailableAccounts();
          if (accounts.length === 0) throw new VEEosError(ErrorCodes.NO_AVAILABLE_INSTANCE, 'No available accounts');
          accountId = accounts[0].id;
        }
        
        const result = await flowTools.openCharacters(accountId);
        return { content: [{ type: 'text', text: JSON.stringify({ accountId, ...result }, null, 2) }] };
      }
      
      // Scenes
      case 'veeos_create_scene': {
        const requiredCredits = instanceManager.estimateCredits('create_scene', args);
        let accountId = args.preferred_account;
        
        if (!accountId) {
          const bestAccount = await instanceManager.getBestAccount(requiredCredits);
          accountId = bestAccount.id;
        }
        
        const { job } = await instanceManager.executeJob(accountId, 'create_scene', args, {
          creditsCost: requiredCredits,
          priority: args.priority,
        });
        
        try {
          const result = await flowTools.createScene(accountId, args);
          await instanceManager.completeJob(accountId, job.id, result);
          return { content: [{ type: 'text', text: JSON.stringify({ jobId: job.id, accountId, ...result }, null, 2) }] };
        } catch (error) {
          await instanceManager.failJob(accountId, job.id, error);
          throw error;
        }
      }
      
      // Grid Architect
      case 'veeos_grid_architect': {
        const requiredCredits = instanceManager.estimateCredits('grid_architect', args);
        let accountId = args.preferred_account;
        
        if (!accountId) {
          const bestAccount = await instanceManager.getBestAccount(requiredCredits);
          accountId = bestAccount.id;
        }
        
        const { job } = await instanceManager.executeJob(accountId, 'grid_architect', args, {
          creditsCost: requiredCredits,
          priority: args.priority,
        });
        
        try {
          const result = await flowTools.useGridArchitect(accountId, args);
          await instanceManager.completeJob(accountId, job.id, result);
          return { content: [{ type: 'text', text: JSON.stringify({ jobId: job.id, accountId, ...result }, null, 2) }] };
        } catch (error) {
          await instanceManager.failJob(accountId, job.id, error);
          throw error;
        }
      }
      
      // Generic tool
      case 'veeos_use_tool': {
        const requiredCredits = instanceManager.estimateCredits('use_tool', args);
        let accountId = args.preferred_account;
        
        if (!accountId) {
          const bestAccount = await instanceManager.getBestAccount(requiredCredits);
          accountId = bestAccount.id;
        }
        
        const { job } = await instanceManager.executeJob(accountId, 'use_tool', args, {
          creditsCost: requiredCredits,
          priority: args.priority,
        });
        
        try {
          const result = await flowTools.useFlowTool(accountId, args);
          await instanceManager.completeJob(accountId, job.id, result);
          return { content: [{ type: 'text', text: JSON.stringify({ jobId: job.id, accountId, ...result }, null, 2) }] };
        } catch (error) {
          await instanceManager.failJob(accountId, job.id, error);
          throw error;
        }
      }
      
      // Download
      case 'veeos_download_latest': {
        const result = await flowTools.downloadLatest(args.account_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      
      // Queue status
      case 'veeos_queue_status': {
        if (args.account_id) {
          const instance = instanceManager.instances.get(args.account_id);
          if (!instance) throw new VEEosError(ErrorCodes.CONFIG_INVALID, `Account not found: ${args.account_id}`);
          return { content: [{ type: 'text', text: JSON.stringify(instance.queue.getStatus(), null, 2) }] };
        }
        
        const status = instanceManager.getStatus();
        const queues = {};
        for (const acc of status.accounts) {
          const instance = instanceManager.instances.get(acc.id);
          if (instance) queues[acc.id] = instance.queue.getStatus();
        }
        return { content: [{ type: 'text', text: JSON.stringify({ queues }, null, 2) }] };
      }
      
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error('MCP tool error', { tool: name, error: error.message, code: error.code });
    
    if (error instanceof McpError) throw error;
    if (error instanceof VEEosError) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: true,
          code: error.code,
          message: error.message,
          details: error.details,
          blocking: isBlockingError(error),
        }, null, 2) }],
        isError: true,
      };
    }
    
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: true,
        code: 'UNKNOWN_ERROR',
        message: error.message,
        blocking: false,
      }, null, 2) }],
      isError: true,
    };
  }
}

export function createMcpServer() {
  const server = new Server(
    { name: 'veeos', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));
  
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await handleToolCall(request.params.name, request.params.arguments);
  });
  
  return server;
}

export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('VEEos MCP server running on stdio');
  return server;
}