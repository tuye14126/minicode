// 加法计算程序
// 支持命令行传参：node add.js 3 5
// 也可以直接运行后交互输入两个数字

import readline from 'readline';

// 检查是否通过命令行传入参数
const args = process.argv.slice(2);

if (args.length >= 2) {
  const a = parseFloat(args[0]);
  const b = parseFloat(args[1]);
  if (isNaN(a) || isNaN(b)) {
    console.log('输入的不是有效数字，请重新运行');
    process.exit(1);
  }
  console.log(`${a} + ${b} = ${a + b}`);
} else {
  // 交互模式：让用户输入两个数字
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('请输入第一个数字: ', (first) => {
    rl.question('请输入第二个数字: ', (second) => {
      const a = parseFloat(first);
      const b = parseFloat(second);
      if (isNaN(a) || isNaN(b)) {
        console.log('输入的不是有效数字，请重新运行');
      } else {
        console.log(`${a} + ${b} = ${a + b}`);
      }
      rl.close();
    });
  });
}
