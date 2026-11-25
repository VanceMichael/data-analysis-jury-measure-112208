# 多赛道评审的评分等值与名额决议

盲评作品编号在跨组共评中保持一致。赛道的奖励保留约定随赛季登记。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

每项奖额表示可同时保留的奖项数，跨赛道奖优先决议，受保护的旧记录参与相关候选的当前名额校验。共同答复要求评委看过相同作品、使用同轮次同口径。

- `entries.json` 记录字段为 `entry`、`track`、`school`、`lang`、`edition`。
- `scores.json` 记录字段为 `entry`、`judge`、`round`、`method`、`design`、`version`、`shared`。
- `recusals.json` 记录字段为 `judge`、`school`、`revision`、`state`。
- `awards.json` 记录字段为 `prize`、`track`、`quota`、`order`、`release`。
- `decisions.json` 记录字段为 `entry`、`prize`、`version`、`state`。
- `award_terms.json` 记录字段为 `prize`、`overlap`、`confirm_within`、`unset_rule`。
- `judge_availability.json` 记录字段为 `judge`、`round`、`language`、`slots`、`edition`。
- `answer_records.json` 记录字段为 `prize`、`entry`、`at`、`answer`、`state`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。

## 赛季工具（`src/`）

工具把“评分比较、实际颁奖、赛后复议”做成可在新赛季重复运行的纯函数管线，
所有业务判定都在无副作用的模块中，CLI 只负责读取资料与渲染报告。

| 模块 | 职责 |
| --- | --- |
| `src/records.js` | 资料加载、字符串到数值的使用点转换、跨表引用校验 |
| `src/equating.js` | 回避追溯、有效共评边、连通分量、评委宽严校正、调整后名次与不确定性 |
| `src/planner.js` | 颁奖截止前的共同评分（补评）规划，并查集模拟验证补评确实合并分量 |
| `src/seats.js` | 席位状态机、答复时间线、关联名额冻结、互斥、保留奖界限、复议级联与等待反查 |
| `src/report.js` | 中文报告与 JSON 共用同一套结论的渲染层 |
| `src/cli.js` | 命令行入口 |

### 命令

```sh
node src/cli.js report   # 全套：等值 + 不确定性 + 补评建议 + 席位决议 + 等待反查
node src/cli.js equating # 仅评分等值、可比范围与名次不确定性
node src/cli.js plan     # 仅可在截止前补的共同评分及其解决的待定名次/奖项
node src/cli.js seats    # 仅颁奖席位、答复链与复议状态
node src/cli.js why      # 从等待原因反查可比性、答复与谁仍占名额
node src/cli.js check    # 资料引用校验（error 时退出码为 1）
```

常用参数：

- `--data=<目录>`：指定赛季资料目录（默认 `./data`），用于新赛季重新运行。
- `--now=<小时>`：赛季时钟，配合 `confirm_within` 判定“到时未答复”。
- `--json`：输出机器可读 JSON，口径与文本报告一致。

也可使用 npm 脚本：`npm run season:report|season:check|season:plan|season:seats|season:why|season:equating`。

### 关键规则如何落地

1. **不按各组均值平移。** 评委宽严只来自同一作品被多名评委共同评分的共评边，
   在每个连通分量内按加法模型 `评分 = 作品水准 + 评委宽严 + 残差` 做最小二乘估计；
   组内作品质量差异不会被误当成评分宽严。
2. **共评边的硬条件。** 必须同一作品、同评分版本、盲评、`shared=yes`，且两侧评分
   均未被回避剔除。仅“评过同一院校的不同作品”不连接两组。
3. **回避追溯生效。** 评委对同校作品已经打过的分（含明评）一并剔除；明评分不参与
   等值，只作留痕。颁奖前新增回避会使共用盲评证据的两组分离。
4. **可比性与不确定性。** 不同连通分量不可比较；同分量不同版本仅弱比较；
   有共同评委直接见证的名次标“确定”，依赖宽严外推且分差不超过残差波动的标“不确定”。
   无有效连接的部分仍可查各赛道内名次。
5. **补评规划。** 只用组织方登记的空闲评委与剩余轮次，校验语言（双语作品要求双语种
   全覆盖）、回避、版本与名额；并用并查集模拟补评后的连通图，只有真正把两个已有分量
   并入同一集合的建议才保留，按所需名额择优、按“锚点作品+合并分量”去重。
6. **跨赛道奖先占建议席位。** 申请人最终确认前，原赛道名额保持保留、不得提前发掉；
   确认接受后才释放其中可递补部分。调换只认时间戳最新的最终回复；同一作品不能在两个
   互斥奖上同时最终获奖。
7. **拒绝/超时与保留奖。** 拒绝或到时未答复打开重新评议窗口；无可比较下一位时按
   `unset_rule` 暂挂或关闭，绝不把名额递给无资格赛道。赞助保留奖必须适用赛道且成绩
   不低于当季界限（如“低于84关闭”），否则空额也不发放。
8. **复议级联。** 已正式接受且评分依据仍有效的奖继续生效；依据失效的发起复议，
   关联的已释放名额在确认到达前冻结。同赛道奖项只有共用同一失效依据或同一席位时才被阻塞。
9. **等待反查。** `why` 从每个待定项回溯其连通分量/共评锚点（可比性）、答复时间线
   以及当前仍占用名额的作品。

## 测试

```sh
npm test
```

- `test/data.test.js`：来源表格式与引用（随仓库提供）。
- `test/records.test.js`、`test/equating.test.js`、`test/planner.test.js`、
  `test/seats.test.js`、`test/e2e.test.js`：工具的单元规则与端到端闭环
  （回避断开 → 补评建议 → 落地后跨赛道依据恢复）。合成夹具集中在
  `test/helpers/fixture.js`，与正式资料保持相同的字符串字段约定。
