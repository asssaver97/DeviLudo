cmake_minimum_required(VERSION 3.28)
project(deviludo_windows_scm_service_bridge VERSION 1.0.0 LANGUAGES C)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "The DeviLudo Windows SCM bridge must be built by the approved MSVC Windows builder")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "Only Windows x86_64 and arm64 service bridge builds are allowed")
endif()

add_executable(deviludo-windows-scm-service-bridge windows-scm-service-bridge.c)
target_compile_features(deviludo-windows-scm-service-bridge PRIVATE c_std_17)
target_compile_options(deviludo-windows-scm-service-bridge PRIVATE
  /W4 /WX /O2 /GL /GS /guard:cf /sdl /utf-8 /volatile:iso
)
target_link_options(deviludo-windows-scm-service-bridge PRIVATE
  /LTCG /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /guard:cf /CETCOMPAT /INCREMENTAL:NO
)
target_link_libraries(deviludo-windows-scm-service-bridge PRIVATE advapi32 bcrypt)
set_target_properties(deviludo-windows-scm-service-bridge PROPERTIES
  OUTPUT_NAME "deviludo-windows-scm-service-bridge"
  C_STANDARD 17
  C_STANDARD_REQUIRED YES
  C_EXTENSIONS NO
)
