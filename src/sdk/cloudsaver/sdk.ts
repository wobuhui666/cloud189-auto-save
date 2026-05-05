const { logTaskEvent } = require('../../utils/logUtils');
const ConfigService = require('../../services/ConfigService');
const fs = require('fs');
const path = require('path');
const got = require('got');

interface LoginResponse {
    code: number;
    success: boolean;
    data: {
        token: string;
    };
}

interface CloudLink {
    cloudType: number;
    link: string;
    accessCode?: string;
}
interface CloudResource {
    messageId: string;
    title: string;
    cloudLinks: CloudLink[];
}

interface SearchResponse {
    code: number;
    success: boolean;
    data: {
        list: CloudResource[];
    }[];
}

class CloudSaverSDK {
    private static instance: CloudSaverSDK;
    private tokenPath: string;
    private token: string;
    private maxRetries: number = 3;
    private retryDelay: number = 1000;

    private constructor() {
        this.tokenPath = path.join(process.cwd(), 'data', 'cstoken.json');
        this.token = this.loadToken();
    }

    public static getInstance(): CloudSaverSDK {
        if (!CloudSaverSDK.instance) {
            CloudSaverSDK.instance = new CloudSaverSDK();
        }
        return CloudSaverSDK.instance;
    }

    get enabled(): boolean {
        return !!this.baseUrl && !!this.username && !!this.password;
    }

    private get baseUrl(): string {
        return ConfigService.getConfigValue('cloudSaver.baseUrl') || '';
    }

    private get username(): string {
        return ConfigService.getConfigValue('cloudSaver.username') || '';
    }

    private get password(): string {
        return ConfigService.getConfigValue('cloudSaver.password') || '';
    }

    async login(): Promise<boolean> {
        if (!this.baseUrl || !this.username || !this.password) {
            logTaskEvent('您还未配置 CloudSaver 请先配置后使用');
            throw new Error('您还未配置 CloudSaver 请先配置后使用');
        }
        try {
            const { body } = await got.post(`${this.baseUrl}/api/user/login`, {
                json: { 
                    username: this.username, 
                    password: this.password 
                },
                responseType: 'json',
                timeout: 3000 // 3秒超时
            });

            const data = body as LoginResponse;
            
            if (data.success && data.code === 0) {
                this.token = data.data.token;
                this.saveToken();
                return true;
            }
            return false;
        } catch (error) {
            logTaskEvent('登录失败:'+ error);
            return false;
        }
    }

    private loadToken(): string {
        try {
            if (fs.existsSync(this.tokenPath)) {
                const data = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
                return data.token || '';
            }
        } catch (error) {
            logTaskEvent('加载 token 失败: ' + error);
        }
        return '';
    }

    private saveToken(): void {
        try {
            const dir = path.dirname(this.tokenPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.tokenPath, JSON.stringify({ token: this.token }));
        } catch (error) {
            logTaskEvent('保存 token 失败: ' + error);
        }
    }

    private async delay(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async autoLogin(): Promise<boolean> {
        if (!this.username || !this.password) {
            throw new Error('CloudSaverSDK 未启用');
        }

        let retries = 0;
        while (retries < this.maxRetries) {
            const success = await this.login();
            if (success) {
                return true;
            }
            retries++;
            if (retries < this.maxRetries) {
                logTaskEvent(`CloudSaverSDK 自动登录失败，第 ${retries} 次重试...`);
                await this.delay(this.retryDelay);
            }
        }
        return false;
    }

    private normalizeResources(resources: CloudResource[]): CloudResource[] {
        const uniqueResources = new Map<string, CloudResource>();
        resources.forEach(resource => {
            if (!uniqueResources.has(resource.messageId)) {
                uniqueResources.set(resource.messageId, resource);
            }
        });

        const result: CloudResource[] = [];
        uniqueResources.forEach(resource => {
            const cloudLinks = resource.cloudLinks.filter(link =>
                link.link.includes('cloud.189.cn')
            );
            cloudLinks.forEach(cloudLink => {
                result.push({
                    messageId: resource.messageId,
                    title: resource.title,
                    cloudLinks: [cloudLink]
                });
            });
        });

        const uniqueLinks = new Map<string, CloudResource>();
        result.forEach(resource => {
            const link = resource.cloudLinks[0].link;
            if (!uniqueLinks.has(link)) {
                uniqueLinks.set(link, resource);
            }
        });
        return Array.from(uniqueLinks.values());
    }

    async search(keyword: string, fast: boolean = false): Promise<CloudResource[]> {
        if (!this.token) {
            const loginSuccess = await this.autoLogin();
            if (!loginSuccess) {
                throw new Error('CloudSaverSDK 自动登录失败，请检查账号密码是否正确');
            }
        }
        try {
            logTaskEvent(`CloudSaverSDK 开始搜索${keyword}`)
            const { body, statusCode } = await got.get(`${this.baseUrl}/api/search`, {
                searchParams: { keyword, ...(fast ? { fast: 'true' } : {}) },
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                responseType: 'json',
                timeout: 30000, // 30秒超时
                throwHttpErrors: false // 不自动抛出HTTP错误
            });

            // 处理 401 未授权的情况
            if (statusCode === 401) {
                logTaskEvent('token 已过期，尝试自动登录...');
                const loginSuccess = await this.autoLogin();
                if (!loginSuccess) {
                    throw new Error('token 已过期，自动登录失败');
                }
                // 重新发起请求
                return this.search(keyword);
            }

            const data = body as SearchResponse;
            if (data.success && data.code === 0) {
                const resources = data.data
                .flatMap(item => item.list)
                .filter(item => 
                    item.cloudLinks?.length > 0 && 
                    item.cloudLinks.some(link => 
                        link.link.includes('cloud.189.cn')
                    )
                );
                const res = this.normalizeResources(resources);
                logTaskEvent(`CloudSaverSDK 清洗后的结果${JSON.stringify(res)}`)
                return res;
            }
            return [];
        } catch (error) {
            throw error;
        }
    }

    /**
     * 获取当前token
     */
    getToken(): string {
        return this.token;
    }

    /**
     * 设置token
     */
    setToken(token: string): void {
        this.token = token;
        this.saveToken();
    }
}

export default CloudSaverSDK.getInstance();
