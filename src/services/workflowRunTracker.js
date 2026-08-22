const crypto = require('crypto');
const { sanitizeWorkflowText, sanitizeWorkflowValue } = require('./workflowRunSanitizer');
const { auditService } = require('./auditService');

const MAX_STEPS = 100;

class WorkflowRunTracker {
    constructor(workflowRunRepo) {
        this.workflowRunRepo = workflowRunRepo || null;
    }

    isEnabled() {
        return Boolean(this.workflowRunRepo);
    }

    async startTaskRun(task, options = {}) {
        if (!this.isEnabled() || !task?.id) {
            return null;
        }

        const now = new Date().toISOString();
        const trigger = String(options.trigger || 'task').trim() || 'task';
        const run = this.workflowRunRepo.create({
            id: crypto.randomUUID(),
            type: 'task_execution',
            status: 'running',
            steps: [{
                index: 0,
                phase: 'start',
                activity: '任务开始执行',
                at: now
            }],
            current: 0,
            context: sanitizeWorkflowValue({
                taskId: task.id,
                taskName: sanitizeWorkflowText(this._taskName(task)),
                accountId: task.accountId,
                trigger: sanitizeWorkflowText(trigger),
                phase: 'start',
                activity: '任务开始执行',
                progress: 0,
                startedAt: now,
                finishedAt: null,
                error: null
            }),
            source: sanitizeWorkflowText(trigger),
            chatId: options.chatId ? String(options.chatId) : null,
            confirmKey: null,
            subjectType: 'task',
            subjectId: String(task.id),
            protocol: 'deterministic',
            summary: ''
        });

        const saved = await this.workflowRunRepo.save(run);
        saved._auditRun = await auditService.mirrorWorkflowRun(saved, {
            module: 'transfer',
            trigger,
            subjectName: this._taskName(task),
            accountId: task.accountId,
            correlationId: task.autoSeriesIntentId ? `intent:${task.autoSeriesIntentId}` : undefined
        });
        return saved;
    }

    async update(run, phase, activity, details = {}) {
        if (!this.isEnabled() || !run) {
            return run;
        }

        const steps = Array.isArray(run.steps) ? [...run.steps] : [];
        const safeDetails = sanitizeWorkflowValue(details || {});
        const nextStep = {
            index: steps.length,
            phase,
            activity,
            at: new Date().toISOString(),
            ...(Object.keys(safeDetails).length > 0 ? { details: safeDetails } : {})
        };
        steps.push(nextStep);
        run.steps = steps.slice(-MAX_STEPS).map((step, index) => ({ ...step, index }));
        run.current = run.steps.length - 1;
        run.context = {
            ...(run.context || {}),
            phase,
            activity,
            progress: this._progressForPhase(phase, run.context?.progress),
            ...(details.error ? { error: sanitizeWorkflowText(details.error).slice(0, 1000) } : {})
        };
        const saved = await this.workflowRunRepo.save(run);
        await auditService.syncWorkflowRun(saved, {
            module: 'transfer',
            subjectName: saved.context?.taskName,
            accountId: saved.context?.accountId
        });
        return saved;
    }

    async finish(run, status, details = {}) {
        if (!this.isEnabled() || !run) {
            return run;
        }

        const finalStatus = ['completed', 'retrying', 'failed'].includes(status) ? status : 'completed';
        const phase = finalStatus === 'completed' ? 'complete' : finalStatus;
        const activity = finalStatus === 'completed'
            ? '任务执行完成'
            : (finalStatus === 'retrying' ? '任务等待重试' : '任务执行失败');
        const updated = await this.update(run, phase, activity, details);
        updated.status = finalStatus;
        updated.context = {
            ...(updated.context || {}),
            progress: finalStatus === 'completed' ? 100 : updated.context?.progress,
            finishedAt: new Date().toISOString(),
            ...(details.error ? { error: sanitizeWorkflowText(details.error).slice(0, 1000) } : {})
        };
        const saved = await this.workflowRunRepo.save(updated);
        await auditService.syncWorkflowRun(saved, {
            module: 'transfer',
            subjectName: saved.context?.taskName,
            accountId: saved.context?.accountId
        });
        return saved;
    }

    _taskName(task) {
        return task.shareFolderName
            ? `${task.resourceName || '未命名'}/${task.shareFolderName}`
            : (task.resourceName || `任务${task.id}`);
    }

    _progressForPhase(phase, previous = 0) {
        const progressByPhase = {
            start: 5,
            metadata: 10,
            account: 18,
            inspect_share: 28,
            inspect_target: 42,
            compare: 55,
            transfer: 68,
            verify: 82,
            finalize: 92,
            complete: 100,
            retrying: 92,
            failed: 92
        };
        return Math.max(Number(previous || 0), progressByPhase[phase] || Number(previous || 0));
    }
}

module.exports = { WorkflowRunTracker };
