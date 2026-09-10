// manager 统一业务错误（HTTP 路由与 AI 档案校验共用；无依赖叶子）。
export function managedError(code, message, status) {
  const error = new Error(message);
  error.managerCode = code;
  error.httpStatus = status;
  return error;
}

