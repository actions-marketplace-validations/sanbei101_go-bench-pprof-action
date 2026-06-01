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

            core.info(`🏁 正在运行基准压测与性能采样 [${pkgName}]...`);
            const cpuProf = path.join(pprofDir, `${pkgName}_cpu.pprof`);
            const memProf = path.join(pprofDir, `${pkgName}_mem.pprof`);

            const benchArgs = [
                'test',
                `-bench=${match}`,
                '-run=^$', 
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

        core.info('📊 正在构建Summary 报告...');
        
        core.summary.addRaw('# 🏎️ go-bench-pprof-action 性能分析报告\n\n');
        core.summary.addRaw(`> 💡 过滤规则: \`${match}\` | 展现深度: Top ${top}\n\n`);

        for (const [pkg, item] of Object.entries(packageResults)) {
            core.summary.addRaw(`## 📦 组件包: ${pkg}\n\n`);

            if (item.testOutput.trim()) {
                core.summary.addRaw(`### 🧪 单元测试运行输出\n\n`);
                core.summary.addRaw(`\`\`\`text\n${item.testOutput.trim()}\n\`\`\`\n\n`);
            }

            if (item.benchOutput.trim() && item.benchOutput.includes('Benchmark')) {
                core.summary.addRaw(`### 🏁 基准测试运行输出\n\n`);
                core.summary.addRaw(`\`\`\`text\n${item.benchOutput.trim()}\n\`\`\`\n\n`);
            }

            const benches = item.benchOutput
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('Benchmark'))
                .map(line => {
                    const firstCol = line.split(/\s+/)[0];
                    const noCpuSuffix = firstCol.split('-')[0];
                    return noCpuSuffix.split('/')[0];
                })
                .filter((v, i, a) => a.indexOf(v) === i);

            if (benches.length > 0 && (fs.existsSync(item.cpuProf) || fs.existsSync(item.memProf))) {
                core.summary.addRaw(`### 🔍 Pprof 数据指标\n\n`);

                for (const bench of benches) {
                    core.summary.addRaw(`#### 📌 函数场景: \`${bench}\`\n\n`);

                    if (fs.existsSync(item.cpuProf)) {
                        let cpuText = '';
                        await exec.exec('go', ['tool', 'pprof', '-text', `-nodecount=${top}`, `-focus=${bench}`, item.cpuProf], {
                            listeners: { stdout: (data: Buffer) => { cpuText += data.toString(); } },
                            silent: true
                        });
                        if (cpuText.includes(bench) || cpuText.split('\n').length > 5) {
                            core.summary.addRaw(`##### 🧠 CPU 耗时 Top 排行\n\n`);
                            core.summary.addRaw(`\`\`\`text\n${cpuText.trim()}\n\`\`\`\n\n`);
                        }
                    }

                    if (mem && fs.existsSync(item.memProf)) {
                        let memText = '';
                        await exec.exec('go', ['tool', 'pprof', '-text', `-nodecount=${top}`, '-alloc_space', `-focus=${bench}`, item.memProf], {
                            listeners: { stdout: (data: Buffer) => { memText += data.toString(); } },
                            silent: true
                        });
                        if (memText.includes(bench) || memText.split('\n').length > 5) {
                            core.summary.addRaw(`##### 💾 内存空间占用 Top 排行\n\n`);
                            core.summary.addRaw(`\`\`\`text\n${memText.trim()}\n\`\`\`\n\n`);
                        }
                    }
                }
            }
            core.summary.addRaw('---\n\n');
        }

        await core.summary.write();
        core.info('🎉 全景画像报告已送达!');

    } catch (error: any) {
        core.setFailed(`❌ ${error.message}`);
    }
}

run();