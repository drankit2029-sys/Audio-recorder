module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import expo.modules.audiohardwarerouter.AudioHardwareRouterPackage;',
        packageInstance: 'new AudioHardwareRouterPackage()',
      },
    },
  },
};
