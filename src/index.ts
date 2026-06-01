import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';

type PackageResult = {
    testOutput: string;
    benchOutput: string;
    cpuProf: string;
    memProf: string;
}

function findTestDirs(dir: string, excludes: string[], fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    let hasTestFile = false;

    for (const file of files) {
        const filePath = path.join(dir, file);
        
        if (excludes.some(exclude => filePath.includes(exclude))) {
            continue;
        }

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            findTestDirs(filePath, excludes, fileList);
        } else if (file.endsWith('_test.go')) {
            hasTestFile = true;
        }
    }

    if (hasTestFile && !fileList.includes(dir)) {
        fileList.push(dir);
    }
    return fileList;
}

async function run(): Promise<void> {
    try {
        const top = core.getInput('top');
        const match = core.getInput('match');
        const mem = core.getBooleanInput('mem');
        const excludeInput = core.getInput('exclude');

        const userExcludes = excludeInput
            .split(',')
            .map(e => e.trim())
            .filter(e => e.length > 0);
        
        const defaultExcludes = ['.git', '.gitignore'];
        const excludes = Array.from(new Set([...defaultExcludes, ...userExcludes]));

        const pprofDir = 'pprof-results';
        if (!fs.existsSync(pprofDir)) {
            fs.mkdirSync(pprofDir, { recursive: true });
        }

        core.info('🕵️‍♂️ 正在根据过滤策略扫描 Go 测试组件...');
        const testDirs = findTestDirs('.', excludes);
        const packageResults: Record<string, PackageResult> = {};

        for (const dir of testDirs) {
            const pkgName = path.basename(dir) || 'root';
            const goTargetDir = dir.startsWith('.') ? dir : `./${dir}`;

            core.startGroup(`📦 正在独立采样组件包: [${pkgName}]`);
            
            // ----------------------------------------------------
            // 单元测试流 (只跑 Test，不跑 Bench)
            // ----------------------------------------------------
            core.info(`🧪 正在运行单元测试 [${pkgName}]...`);
            let testOutput = '';
            await exec.exec('go', ['test', `-run=${match}`, '-v', goTargetDir], {
                listeners: {
                    stdout: (data: Buffer) => { testOutput += data.toString(); },
                    stderr: (data: Buffer) => { testOutput += data.toString(); }
                },
                silent: false,
                ignoreReturnCode: true
            });

            // ----------------------------------------------------
            // 基准测试与采样流 (只跑 Bench，不跑 Test)
            // ----------------------------------------------------
            core.info(`🏁 正在运行基准压测与性能采样 [${pkgName}]...`);
            const cpuProf = path.join(pprofDir, `${pkgName}_cpu.pprof`);
            const memProf = path.join(pprofDir, `${pkgName}_mem.pprof`);

            const benchArgs = [
                'test',
                `-bench=${match}`,
                '-run=^$', // 屏蔽单元测试
                '-v',
                `-cpuprofile=${cpuProf}`
            ];
            if (mem) {
                benchArgs.push(`-memprofile=${memProf}`);
            }
            benchArgs.push(goTargetDir);

            let benchOutput = '';
            await exec.exec('go', benchArgs, {
                listeners: {
                    stdout: (data: Buffer) => { benchOutput += data.toString(); },
                    stderr: (data: Buffer) => { benchOutput += data.toString(); }
                },
                silent: false,
                ignoreReturnCode: true
            });

            packageResults[pkgName] = { testOutput, benchOutput, cpuProf, memProf };
            core.endGroup();
        }


        core.info('📊 正在构建 Summary 报告...');
        
        core.summary.addHeading('🏎️ go-bench-pprof-action 性能分析报告', 1);
        
        core.summary.addQuote(`💡 过滤规则: \`${match}\` | 展现深度: Top ${top}`);

        for (const [pkg, item] of Object.entries(packageResults)) {
            core.summary.addHeading(`📦 组件包: ${pkg}`, 2);

            if (item.testOutput.trim()) {
                core.summary.addHeading('🧪 1. 单元测试运行输出 (Unit Test)', 3);
                core.summary.addCodeBlock(item.testOutput.trim(), 'text');
            }

            if (item.benchOutput.trim() && item.benchOutput.includes('Benchmark')) {
                core.summary.addHeading('🏁 2. 基准测试运行输出 (Benchmark)', 3);
                core.summary.addCodeBlock(item.benchOutput.trim(), 'text');
            }

            let hasPprofData = false;
            let cpuText = '';
            let memText = '';

            if (fs.existsSync(item.cpuProf)) {
                await exec.exec('go', ['tool', 'pprof', '-text', `-nodecount=${top}`, item.cpuProf], {
                    listeners: { stdout: (data: Buffer) => { cpuText += data.toString(); } },
                    silent: true
                });
                if (cpuText.trim()) hasPprofData = true;
            }

            if (mem && fs.existsSync(item.memProf)) {
                await exec.exec('go', ['tool', 'pprof', '-text', `-nodecount=${top}`, '-inuse_space', item.memProf], {
                    listeners: { stdout: (data: Buffer) => { memText += data.toString(); } },
                    silent: true
                });
                if (memText.trim()) hasPprofData = true;
            }

            if (hasPprofData) {
                core.summary.addHeading('🔍 3. Pprof 提纯数据指标 (Go Tool Pprof)', 3);
                if (cpuText.trim()) {
                    core.summary.addHeading('🧠 CPU 耗时 Top 排行', 4);
                    core.summary.addCodeBlock(cpuText.trim(), 'text');
                }
                
                if (memText.trim()) {
                    core.summary.addHeading('💾 内存空间占用 Top 排行', 4);
                    core.summary.addCodeBlock(memText.trim(), 'text');
                }
            }
            core.summary.addSeparator();
        }

        await core.summary.write();
        core.info('🎉 语义化流式性能报告已完美送达!');

    } catch (error: any) {
        core.setFailed(`❌ ${error.message}`);
    }
}

run();