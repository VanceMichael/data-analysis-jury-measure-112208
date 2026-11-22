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

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
