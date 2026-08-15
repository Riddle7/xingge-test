# 刑法分诊词表（供 LLM 分诊使用）

## subfield 判定线索
- criminal_law_core（实体刑法核心）: criminal law, criminal liability, mens rea, actus reus,
  culpability, criminal responsibility, elements of the offence, attempted crime, complicity,
  joint offending, self-defence/self-defense, justification, necessity, insanity defence,
  intoxication, strict liability, homicide, murder, manslaughter, assault, theft, robbery,
  burglary, fraud, corruption, bribery, drug offences/trafficking, cybercrime, terrorism,
  terrorist financing, money laundering, corporate criminal liability, criminalization,
  decriminalization, overcriminalization, theory of punishment, retribution, deterrence,
  proportionality of punishment, sentencing theory, penal theory, purposes of punishment
- criminal_procedure: criminal procedure, due process, presumption of innocence, standard of
  proof, exclusionary rule, right to counsel, custodial interrogation, confession, plea
  bargaining, prosecutorial discretion, pretrial detention, jury trial, double jeopardy,
  wrongful conviction, criminal appeal, evidence law (criminal context)
- international_criminal_law: international criminal court, ICC, Rome Statute, war crimes,
  crimes against humanity, genocide, crime of aggression, universal jurisdiction,
  international criminal tribunal, transnational organised crime, extradition
- criminology: crime rate, offending, recidivism, criminal careers, victimization, fear of
  crime, crime prevention, situational prevention, deterrence studies (empirical)
- penology: imprisonment, prison, incarceration, parole, probation, community sanctions,
  solitary confinement, prisoner reentry, rehabilitation programmes
- interdisciplinary: 法律与心理学/经济学/技术交叉且与刑事实体法或刑事程序相关

## relevance=borderline 的典型情形
- 纯犯罪学实证研究（问卷、统计建模）而完全不涉及规范讨论
- 警务管理、监狱卫生、受害者心理干预、青少年司法社会工作
- 仅在结论或背景中顺带提及刑法问题
- 无法从标题和摘要判断研究对象是否为刑法问题

## 明确 irrelevant 的情形（此情形仍输出 borderline 由人工裁决，不直接丢弃）
- 民商法、宪法、行政法、国际公法（非刑事）、纯方法学/统计学研究
