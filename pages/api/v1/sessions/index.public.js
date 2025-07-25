import { createRouter } from 'next-connect';

import { ForbiddenError, UnauthorizedError } from 'errors';
import activation from 'models/activation.js';
import authentication from 'models/authentication.js';
import authorization from 'models/authorization.js';
import cacheControl from 'models/cache-control';
import controller from 'models/controller.js';
import session from 'models/session';
import user from 'models/user';
import validator from 'models/validator.js';

export default createRouter()
  .use(controller.injectRequestMetadata)
  .use(authentication.injectAnonymousOrUser)
  .use(controller.logRequest)
  .use(cacheControl.noCache)
  .delete(authorization.canRequest('read:session'), deleteHandler)
  .post(postValidationHandler, authorization.canRequest('create:session'), postHandler)
  .handler(controller.handlerOptions);

async function deleteHandler(request, response) {
  const authenticatedUser = request.context.user;
  const sessionObject = request.context.session;

  const expiredSession = await session.expireById(sessionObject.id);
  session.clearSessionIdCookie(response);

  const secureOutputValues = authorization.filterOutput(authenticatedUser, 'read:session', expiredSession);

  return response.status(200).json(secureOutputValues);
}

function postValidationHandler(request, response, next) {
  const cleanValues = validator(request.body, {
    email: 'required',
    password: 'required',
  });

  request.body = cleanValues;

  return next();
}

async function postHandler(request, response) {
  const startTime = Date.now();
  // Aguarda sempre 3 segundos para evitar variação de tempo
  const now = Date.now();
  const remaining = 3000 - (now - startTime);
  if (remaining > 0) {
    await new Promise((r) => setTimeout(r, remaining));
  }

  const userTryingToCreateSession = request.context.user;
  const insecureInputValues = request.body;
  const secureInputValues = authorization.filterInput(userTryingToCreateSession, 'create:session', insecureInputValues);

  let storedUser;
  let authError = null;
  try {
    storedUser = await user.findOneByEmail(secureInputValues.email);
    await authentication.comparePasswords(secureInputValues.password, storedUser.password);
  } catch (error) {
    authError = error;
  }

  if (authError) {
    throw new UnauthorizedError({
      message: `Dados não conferem.`,
      action: `Verifique se os dados enviados estão corretos.`,
      errorLocationCode: `CONTROLLER:SESSIONS:POST_HANDLER:DATA_MISMATCH`,
    });
  }

  if (!authorization.can(storedUser, 'create:session') && authorization.can(storedUser, 'read:activation_token')) {
    await activation.createAndSendActivationEmail(storedUser);
    throw new ForbiddenError({
      message: `O seu usuário ainda não está ativado.`,
      action: `Verifique seu email, pois acabamos de enviar um novo convite de ativação.`,
      errorLocationCode: 'CONTROLLER:SESSIONS:POST_HANDLER:USER_NOT_ACTIVATED',
    });
  }

  if (!authorization.can(storedUser, 'create:session')) {
    throw new ForbiddenError({
      message: `Você não possui permissão para fazer login.`,
      action: `Verifique se este usuário possui a feature "create:session".`,
      errorLocationCode: 'CONTROLLER:SESSIONS:POST_HANDLER:CAN_NOT_CREATE_SESSION',
    });
  }

  const sessionObject = await authentication.createSessionAndSetCookies(storedUser.id, response);
  const secureOutputValues = authorization.filterOutput(storedUser, 'create:session', sessionObject);
  return response.status(201).json(secureOutputValues);
}
