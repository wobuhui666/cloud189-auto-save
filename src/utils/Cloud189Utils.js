class Cloud189Utils {
    static SHARE_CODE_PATTERN = /^(?:uuid)?[a-zA-Z0-9_-]{8,}$/;
    static SUBSCRIPTION_UUID_PATTERN = /^[a-zA-Z0-9_-]{6,}$/;

    static _decodeShareText(shareText = '') {
        try {
            return decodeURIComponent(shareText);
        } catch (error) {
            return shareText;
        }
    }

    static _normalizeShareText(shareText = '') {
        return this._decodeShareText(String(shareText || '')).replace(/\s/g, '');
    }

    static _extractShareCodeFromUrl(shareLink) {
        const shareUrl = new URL(shareLink);
        let shareCode = '';
        if (shareUrl.origin.includes('content.21cn.com')) {
            const hashQuery = shareUrl.hash.includes('?') ? shareUrl.hash.split('?')[1] : '';
            const hashParams = new URLSearchParams(hashQuery);
            shareCode = hashParams.get('shareCode') || shareUrl.searchParams.get('shareCode');
        } else if (shareUrl.pathname === '/web/share') {
            shareCode = shareUrl.searchParams.get('code');
        } else if (shareUrl.pathname.startsWith('/t/')) {
            shareCode = shareUrl.pathname.split('/').pop();
        } else if (shareUrl.hash && shareUrl.hash.includes('/t/')) {
            shareCode = shareUrl.hash.split('/').pop()?.split('?')[0];
        } else if (shareUrl.pathname.includes('share.html')) {
            const hashParts = shareUrl.hash.split('/');
            shareCode = hashParts[hashParts.length - 1]?.split('?')[0];
        }
        return shareCode || '';
    }

    static _extractSubscriptionUuidFromUrl(subscriptionLink) {
        const subscriptionUrl = new URL(subscriptionLink);
        const hashQuery = subscriptionUrl.hash.includes('?') ? subscriptionUrl.hash.split('?')[1] : '';
        const hashParams = new URLSearchParams(hashQuery);
        return (
            hashParams.get('uuid')
            || subscriptionUrl.searchParams.get('uuid')
            || ''
        );
    }

    static buildSubscriptionHomeUrl(uuid) {
        return `https://content.21cn.com/h5/subscrip/index.html#/pages/own-home/index?uuid=${encodeURIComponent(uuid)}`;
    }

    static buildSubscriptionDetailsUrl(shareCode) {
        return `https://content.21cn.com/h5/subscrip/index.html#/pages/details/index?shareCode=${encodeURIComponent(shareCode)}`;
    }

    static _buildSubscriptionShareUrl(shareCode) {
        return this.buildSubscriptionDetailsUrl(shareCode);
    }

    static parseSubscriptionUuid(subscriptionText) {
        const normalizedInput = this._normalizeShareText(subscriptionText);
        if (!normalizedInput) {
            throw new Error('订阅 UUID 不能为空');
        }

        const directUuid = normalizedInput.replace(/^uuid=/i, '');
        if (this.SUBSCRIPTION_UUID_PATTERN.test(directUuid)) {
            return directUuid;
        }

        let uuid = '';
        try {
            uuid = this._extractSubscriptionUuidFromUrl(normalizedInput);
        } catch (error) {
            const matchedUuid = normalizedInput.match(/[?&#]uuid=([a-zA-Z0-9_-]{6,})/i);
            uuid = matchedUuid?.[1] || '';
        }

        const normalizedUuid = this._normalizeShareText(uuid).replace(/^uuid=/i, '');
        if (!this.SUBSCRIPTION_UUID_PATTERN.test(normalizedUuid)) {
            throw new Error('无效的订阅链接');
        }

        return normalizedUuid;
    }

    // 解析分享码
    static parseShareCode(shareLink) {
        const normalizedShareLink = this._normalizeShareText(shareLink);
        if (this.SHARE_CODE_PATTERN.test(normalizedShareLink)) {
            return normalizedShareLink;
        }

        let shareCode = '';
        try {
            shareCode = this._extractShareCodeFromUrl(normalizedShareLink);
        } catch (error) {
            throw new Error('无效的分享链接');
        }

        if (!shareCode) throw new Error('无效的分享链接');
        return shareCode
    }

    static parseCloudShare(shareText) {
        shareText = this._normalizeShareText(shareText);
        let url = '';
        let accessCode = '';

        const accessCodePatterns = [
            /[（(]访问码[：:]\s*([a-zA-Z0-9]{4})[)）]/,
            /[（(]提取码[：:]\s*([a-zA-Z0-9]{4})[)）]/,
            /访问码[：:]\s*([a-zA-Z0-9]{4})/,
            /提取码[：:]\s*([a-zA-Z0-9]{4})/,
            /[（(]([a-zA-Z0-9]{4})[)）]/
        ];

        for (const pattern of accessCodePatterns) {
            const match = shareText.match(pattern);
            if (match) {
                accessCode = match[1];
                shareText = shareText.replace(match[0], '');
                break;
            }
        }

        shareText = this._normalizeShareText(shareText);

        if (this.SHARE_CODE_PATTERN.test(shareText)) {
            url = this._buildSubscriptionShareUrl(shareText);
        } else {
            const urlPatterns = [
                /(https?:\/\/cloud\.189\.cn\/web\/share\?[^\s]+)/,
                /(https?:\/\/cloud\.189\.cn\/t\/[a-zA-Z0-9_-]+)/,
                /(https?:\/\/h5\.cloud\.189\.cn\/share\.html#\/t\/[a-zA-Z0-9_-]+)/,
                /(https?:\/\/[^/]+\/web\/share\?[^\s]+)/,
                /(https?:\/\/[^/]+\/t\/[a-zA-Z0-9_-]+)/,
                /(https?:\/\/[^/]+\/share\.html[^\s]*)/,
                /(https?:\/\/content\.21cn\.com[^\s]+)/
            ];

            for (const pattern of urlPatterns) {
                const urlMatch = shareText.match(pattern);
                if (urlMatch) {
                    url = urlMatch[1];
                    break;
                }
            }
        }

        return {
            url: url,
            accessCode: accessCode
        };
    }
}

module.exports = Cloud189Utils;
