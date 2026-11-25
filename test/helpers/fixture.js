// 测试用合成赛季构造器：字符串格式与正式资料一致（所有标量均为字符串）。
export function makeSeason(overrides = {}) {
  const base = {
    entries: [
      { entry: 'E1', track: '旅行', school: 'S1', lang: '中', edition: 'V1' },
      { entry: 'E2', track: '会展', school: 'S2', lang: '英', edition: 'V1' },
      { entry: 'E3', track: '旅行', school: 'S3', lang: '中', edition: 'V1' },
      { entry: 'E4', track: '会展', school: 'S4', lang: '英', edition: 'V1' },
      { entry: 'E5', track: '酒店', school: 'S5', lang: '泰', edition: 'V2' },
    ],
    scores: [
      { entry: 'E1', judge: 'J1', round: '1', method: '盲', design: '88', version: '1', shared: 'yes' },
      { entry: 'E1', judge: 'J2', round: '1', method: '盲', design: '81', version: '1', shared: 'yes' },
      { entry: 'E2', judge: 'J1', round: '1', method: '盲', design: '86', version: '1', shared: 'yes' },
      { entry: 'E2', judge: 'J2', round: '1', method: '盲', design: '80', version: '1', shared: 'yes' },
      { entry: 'E3', judge: 'J1', round: '1', method: '盲', design: '90', version: '1', shared: 'no' },
      { entry: 'E4', judge: 'J2', round: '1', method: '盲', design: '82', version: '1', shared: 'no' },
      { entry: 'E5', judge: 'J3', round: '1', method: '盲', design: '92', version: '2', shared: 'no' },
    ],
    recusals: [],
    awards: [
      { prize: 'P1', track: '跨赛道', quota: '1', order: '1', release: '确认后' },
      { prize: 'P2', track: '旅行', quota: '1', order: '2', release: '确认后' },
      { prize: 'P3', track: '会展', quota: '1', order: '2', release: '确认后' },
      { prize: 'P5', track: '会展', quota: '1', order: '3', release: '符合保留条件' },
    ],
    decisions: [],
    award_terms: [
      { prize: 'P1', overlap: '接受后释放单赛道', confirm_within: '48', unset_rule: '待共同评议' },
      { prize: 'P2', overlap: '与P1不可兼领', confirm_within: '48', unset_rule: '保留' },
      { prize: 'P3', overlap: '与P1不可兼领', confirm_within: '48', unset_rule: '保留' },
      { prize: 'P5', overlap: '与P1不可兼领', confirm_within: '24', unset_rule: '低于84关闭' },
    ],
    judge_availability: [
      { judge: 'J1', round: '3', language: '中', slots: '1', edition: 'V1' },
      { judge: 'J4', round: '3', language: '中+英', slots: '2', edition: 'V1' },
    ],
    answer_records: [],
  }
  const season = structuredClone(base)
  for (const [key, value] of Object.entries(overrides)) {
    season[key] = structuredClone(value)
  }
  return season
}
