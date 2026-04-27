const fs = require('fs');
const path = require('path');
class ConfigService {
  constructor() {
    // 配置文件路径
    this._configPath = path.join(__dirname, '../../data');
    this._configFile = this._configPath + '/config.json';
    this._config = {
      task: {
        taskExpireDays: 3,
        taskCheckCron: '0 19-23 * * *',
        cleanRecycleCron: '0 */8 * * *',
        lazyFileCleanupCron: '0 */6 * * *',
        maxRetries: 3,        // 最大重试次数
        retryInterval: 300,   // 重试间隔（秒）
        enableAutoClearRecycle: false,
        enableAutoClearFamilyRecycle: false,
        enableAutoCleanLazyFiles: false,
        lazyFileRetentionHours: 24,
        mediaSuffix: '.mkv;.iso;.ts;.mp4;.avi;.rmvb;.wmv;.m2ts;.mpg;.flv;.rm;.mov;.cas', // 媒体文件后缀
        enableOnlySaveMedia: false, // 只保存媒体文件
        enableAutoDeleteCompletedTask: false, // 任务完结后自动删除任务记录
        enableAutoCreateFolder: false,
        autoCreate: {
          accountId: '',
          targetFolderId: '',
          targetFolder: '',
          organizerTargetFolderId: '',
          organizerTargetFolderName: '',
          mode: 'lazy'
        }
      },
      // CAS 配置（已迁移到独立配置节点，保留 task 部分用于兼容）
      cas: {
        enableAutoRestore: false,      // 启用自动恢复
        autoRestorePaths: [],          // 自动恢复监控路径 [{ accountId, folderId, folderPath, enabled }]
        deleteCasAfterRestore: true,   // 恢复后删除CAS文件
        deleteSourceAfterGenerate: false, // 生成CAS后删除源文件
        enableFamilyTransit: true,     // 启用家庭中转
        familyTransitFirst: false,     // 优先家庭中转
        scanInterval: 300,             // 扫描间隔（秒）
        tempFileTtl: 300               // 临时播放文件保留时间（秒）
      },
      wecom: {
        enable: false,
        webhook: ''
      },
        telegram: {
          enable: false,
          proxyDomain: '',
          botToken: '',
          chatId: '',
          bot: {
            enable: false,
            botToken: '',
            chatId: '',
            silentMode: false
          }
        },
      wxpusher: {
        enable: false,
        spt: ''
      },
      proxy: {
        host: '',
        port: 0,
        username: '',
        password: '',
        services: {
          telegram: true,
          tmdb: true,
          cloud189: false
        }
      },
      bark: {
        enable: false,
        serverUrl: '', 
        key: ''
      },
      pushplus: {
        enable: false,           // 是否启用推送
        token: '',              // PushPlus token
        topic: '',              // 群组编码，不填仅发送给自己
        channel: 'wechat',      // 发送渠道：wechat/webhook/cp/sms/mail
        webhook: '',            // webhook编码，仅在channel为webhook时需要
        to: ''                  // 好友令牌，用于指定接收消息的用户
    },
      system: {
        username: 'admin',
        password: 'admin',
        baseUrl: '',
        apiKey: '',
        streamProxySecret: '',
        logExpireDays: 7,
        logCleanupCron: '0 3 * * *'
      },
      strm: {
        enable: false,
        useStreamProxy: false,
      },
      emby: {
        enable: false,
        serverUrl: '',
        apiKey: '',
        proxy: {
          enable: false,
          port: 8097
        },
        prewarm: {
          enable: false,
          sessionPollIntervalMs: 30000,
          dedupeTtlMs: 300000
        }
      },
      cloudSaver: {
        baseUrl: '',
        username: '',
        password: ''
      },
      tmdb: {
        enableScraper: false,
        apiKey: '',
        tmdbApiKey: ''
      },
      organizer: {
        categories: {
          tv: '电视剧',
          anime: '动漫',
          movie: '电影',
          variety: '综艺',
          documentary: '纪录片'
        },
        paused: false
      },
      openai: {
        enable: false,
        mode: 'fallback',
        baseUrl: '',
        apiKey: '',
        model: 'GLM-4-Flash-250414',
        flowControlEnabled: false,
        rename: {
          template: "{name} - {se}{ext}",  // 默认模板
          movieTemplate: "{name} ({year}){ext}",  // 电影模板
        }
      },
      alist: {
        enable: false,
        baseUrl: '',
        apiKey: ''
      },
      regexPresets: [],
      customPush: [] // 自定义推送
    };
    this._init();
  }

  _init() {
    try {
      if (!fs.existsSync(this._configPath)) {
        fs.mkdirSync(this._configPath, { recursive: true });
      }
      if (fs.existsSync(this._configFile)) {
        const data = fs.readFileSync(this._configFile, 'utf8');
        const fileConfig = JSON.parse(data);
        this._config = this._deepMerge(this._config, fileConfig);
      }else {
        this._saveConfig();
      }
    } catch (error) {
      console.error('系统配置初始化失败:', error);
    }
  }

  // 添加深度合并方法
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key in source) {
      if (source[key] instanceof Object && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }


  _saveConfig() {
    try {
      fs.writeFileSync(this._configFile, JSON.stringify(this._config, null, 2));
    } catch (error) {
      console.error('系统配置保存失败:', error);
    }
  }

  getConfig() {
    return this._config;
  }

  setConfig(config) {
    this._config = { ...this._config, ...config };
    this._saveConfig();
  }

  getConfigValue(key, defaultValue = null) {
    const keys = key.split('.');
    let value = this._config;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) break;
    }
    return value ?? defaultValue;
  }

  setConfigValue(key, value) {
    const keys = key.split('.');
    let current = this._config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    this._saveConfig();
  }
}

// 导出单例实例
module.exports = new ConfigService();
