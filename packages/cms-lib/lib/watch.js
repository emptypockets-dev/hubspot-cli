const path = require('path');
const fs = require('fs');
const moment = require('moment');
const chokidar = require('chokidar');
const debounce = require('debounce');
const { default: PQueue } = require('p-queue');

const { logger } = require('../logger');
const {
  ApiErrorContext,
  logApiErrorInstance,
  logApiUploadErrorInstance,
} = require('../errorHandlers');
const { uploadFolder } = require('./uploadFolder');
const { shouldIgnoreFile, ignoreFile } = require('../ignoreRules');
const { getFileMapperApiQueryFromMode } = require('../fileMapper');
const { upload, deleteFile } = require('../api/fileMapper');
const escapeRegExp = require('./escapeRegExp');
const { convertToUnixPath, isAllowedExtension } = require('../path');

const notifyQueue = [];
const notifyPromises = [];
const debouncedWaitForActionsToCompleteAndWriteQueueToFile = debounce(
  waitForActionsToCompleteAndWriteQueueToFile,
  1500
);

const queue = new PQueue({
  concurrency: 10,
});

function triggerNotify(filePathToNotify, actionType, filePath, actionPromise) {
  if (filePathToNotify) {
    notifyQueue.push(`${moment().toISOString()} ${actionType}: ${filePath}\n`);
    notifyPromises.push(actionPromise);
    debouncedWaitForActionsToCompleteAndWriteQueueToFile(filePathToNotify);
  }
}

function waitForActionsToCompleteAndWriteQueueToFile(filePathToNotify) {
  const actionOutput = notifyQueue.join('');
  const allNotifyPromisesResolution = Promise.all(notifyPromises);

  console.log(notifyPromises.length, notifyQueue.length);

  notifyPromises.length = 0;
  notifyQueue.length = 0;

  allNotifyPromisesResolution.then(() => {
    console.log(notifyPromises.length, notifyQueue.length);
    const notifyOutput = `${moment().toISOString()} Notify Triggered\n`;
    notifyFilePath(filePathToNotify, actionOutput.concat(notifyOutput));
  });
}

function notifyFilePath(filePathToNotify, outputToWrite) {
  if (filePathToNotify) {
    try {
      fs.appendFileSync(filePathToNotify, outputToWrite);
    } catch (e) {
      logger.error(`Unable to notify file ${filePathToNotify}: ${e}`);
    }
  }
}

function uploadFile(portalId, file, dest, { mode, cwd }) {
  if (!isAllowedExtension(file)) {
    logger.debug(`Skipping ${file} due to unsupported extension`);
    return;
  }
  if (shouldIgnoreFile(file, cwd)) {
    logger.debug(`Skipping ${file} due to an ignore rule`);
    return;
  }

  logger.debug('Attempting to upload file "%s" to "%s"', file, dest);
  const apiOptions = {
    qs: getFileMapperApiQueryFromMode(mode),
  };
  return queue.add(() => {
    return upload(portalId, file, dest, apiOptions)
      .then(() => {
        logger.log(`Uploaded file ${file} to ${dest}`);
      })
      .catch(() => {
        const uploadFailureMessage = `Uploading file ${file} to ${dest} failed`;
        logger.debug(uploadFailureMessage);
        logger.debug('Retrying to upload file "%s" to "%s"', file, dest);
        return upload(portalId, file, dest, apiOptions).catch(error => {
          logger.error(uploadFailureMessage);
          logApiUploadErrorInstance(
            error,
            new ApiErrorContext({
              portalId,
              request: dest,
              payload: file,
            })
          );
        });
      });
  });
}

async function deleteRemoteFile(portalId, filePath, remoteFilePath, { cwd }) {
  if (shouldIgnoreFile(filePath, cwd)) {
    logger.debug(`Skipping ${filePath} due to an ignore rule`);
    return;
  }

  logger.debug('Attempting to delete file "%s"', remoteFilePath);
  return queue.add(() => {
    return deleteFile(portalId, remoteFilePath)
      .then(() => {
        logger.log(`Deleted file ${remoteFilePath}`);
      })
      .catch(error => {
        logger.error(`Deleting file ${remoteFilePath} failed`);
        logApiErrorInstance(
          error,
          new ApiErrorContext({
            portalId,
            request: remoteFilePath,
          })
        );
      });
  });
}

function watch(
  portalId,
  src,
  dest,
  { mode, cwd, remove, disableInitial, notify }
) {
  const regex = new RegExp(`^${escapeRegExp(src)}`);

  if (notify) {
    ignoreFile(notify);
  }

  const watcher = chokidar.watch(src, {
    ignoreInitial: true,
    ignored: file => shouldIgnoreFile(file, cwd),
  });

  const getDesignManagerPath = file => {
    const relativePath = file.replace(regex, '');
    return convertToUnixPath(path.join(dest, relativePath));
  };

  if (!disableInitial) {
    // Use uploadFolder so that failures of initial upload are retried
    uploadFolder(portalId, src, dest, { mode, cwd }).then(() => {
      logger.log(
        `Completed uploading files in ${src} to ${dest} in ${portalId}`
      );
    });
  }

  watcher.on('ready', () => {
    logger.log(`Watcher is ready and watching ${src}`);
  });

  watcher.on('add', async filePath => {
    const destPath = getDesignManagerPath(filePath);
    const uploadPromise = uploadFile(portalId, filePath, destPath, {
      mode,
      cwd,
    });
    triggerNotify(notify, 'Added', filePath, uploadPromise);
  });

  if (remove) {
    watcher.on('unlink', async filePath => {
      const remotePath = getDesignManagerPath(filePath);
      const deletePromise = deleteRemoteFile(portalId, filePath, remotePath, {
        cwd,
      });
      triggerNotify(notify, 'Removed', filePath, deletePromise);
    });
  }

  watcher.on('change', async filePath => {
    const destPath = getDesignManagerPath(filePath);
    const uploadPromise = uploadFile(portalId, filePath, destPath, {
      mode,
      cwd,
    });
    triggerNotify(notify, 'Changed', filePath, uploadPromise);
  });

  return watcher;
}

module.exports = {
  watch,
};
