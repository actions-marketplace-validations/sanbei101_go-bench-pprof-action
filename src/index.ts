import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';

type BenchItem = {
    bench: string;
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

        const excludes = excludeInput
            .split(',')
            .map(e => e.trim())
            .filter(e => e.length > 0);

        const pprofDir = 'pprof-results';
        if (!fs.existsSync(pprofDir)) {
            fs.mkdirSync(pprofDir, { recursive: true });
        }

        core.info('🕵️‍♂️ 正在根据过滤策略扫描 Go 测试组件...');
        const testDirs = findTestDirs('.', excludes);

        const packageGroups: Record<string, BenchItem[]> = {};

        for (const dir of testDirs) {
            const pkgName = path.basename(dir) || 'root';

            let benchListStr = '';
            await exec.exec('go', ['test', '-run=^$', `-list=${match}`, dir], {
                listeners: {
                    stdout: (data: Buffer) => { benchListStr += data.toString(); }
                },
                silent: true
            });

            const benches = benchListStr
                .split('\n')
                .map(b => b.trim())
                .filter(b => b.startsWith('Benchmark'));

            if (benches.length === 0) continue;

            packageGroups[pkgName] = [];
            core.startGroup(`📦 正在精准剖析组件包: [${pkgName}]`);

            for (const bench of benches) {
                core.info(`🎯 正在对独立函数 [${bench}] 进行纯净孤立采样...`);
                
                const cpuProf = path.join(pprofDir, `${pkgName}_${bench}_cpu.pprof`);
                const memProf = path.join(pprofDir, `${pkgName}_${bench}_mem.pprof`);

                const testArgs = [
                    'test',
                    `-bench=^${bench}$`,
                    '-run=^$',
                    '-v',
                    `-cpuprofile=${cpuProf}`
                ];

                if (mem) {
                    testArgs.push(`-memprofile=${memProf}`);
                }
                testArgs.push(dir);

                await exec.exec('go', testArgs, { silent: true });
                packageGroups[pkgName].push({ bench, cpuProf, memProf });
            }
            core.endGroup();
        }

        core.info('📊 正在通过 go tool pprof 提纯细粒度函数数据并写入 Summary...');
        
        core.summary.addHeading('# 🏎️ go-bench-pprof-action 性能分析报告', 1);
        core.summary.addRaw(`💡 过滤规则: \`${match}\` | 展现深度: Top ${top}\n\n`);

        for (const [pkg, items] of Object.entries(packageGroups)) {
            core.summary.addHeading(`📦 组件包: ${pkg}`, 2);

            for (const item of items) {
                core.summary.addHeading(`📌 函数场景: \`${item.bench}\``, 3);

                if (fs.existsSync(item.cpuProf)) {
                    let cpuText = '';
                    await exec.exec('go', ['tool', 'pprof', '-text', `-nodecount=${top}`, item.cpuProf], {
                        listeners: { stdout: (data: Buffer) => { cpuText += data.toString(); } },
                        silent: true
                    });
                    core.summary.addRaw('**🧠 CPU 耗时 Top 排行:**\n');
                    core.summary.addCodeBlock(cpuText.trim(), 'text');
                }

                if (mem && fs.existsSync(item.memProf)) {
                    let memText = '';
                    await exec.exec('go', ['tool', 'pprof', '-text', `-nodecount=${top}`, '-inuse_space', item.memProf], {
                        listeners: { stdout: (data: Buffer) => { memText += data.toString(); } },
                        silent: true
                    });
                    core.summary.addRaw('**💾 内存空间占用 Top 排行:**\n');
                    core.summary.addCodeBlock(memText.trim(), 'text');
                }

                core.summary.addRaw('---\n');
            }
        }

        await core.summary.write();
        core.info('🎉 函数级全景性能画像已完美送达!');

    } catch (error: any) {
        core.setFailed(`❌ ${error.message}`);
    }
}

run();